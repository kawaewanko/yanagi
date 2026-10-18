#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -f .env ]]; then
  echo "Missing .env. Run: cp .env.example .env" >&2
  exit 2
fi

set -a
source .env
set +a

api_url="${CORE_API_URL:-http://127.0.0.1:3000}"
worker_key="${CORE_API_KEY_WORKER:-}"
max_age="${HEALTH_MAX_AGE_SECONDS:-90}"

if [[ -z "$worker_key" ]]; then
  echo "Missing CORE_API_KEY_WORKER" >&2
  exit 2
fi

curl --fail --silent --show-error "$api_url/health" >/dev/null

status_json="$(curl --fail --silent --show-error \
  -H "Authorization: Bearer $worker_key" \
  "$api_url/v1/dashboard/status")"

STATUS_JSON="$status_json" MAX_AGE="$max_age" node <<'NODE'
const payload = JSON.parse(process.env.STATUS_JSON ?? "{}");
const maxAge = Number(process.env.MAX_AGE ?? "90") * 1000;
if (!Number.isFinite(maxAge) || maxAge <= 0) {
  throw new Error("HEALTH_MAX_AGE_SECONDS must be a positive number");
}
const expected = [
  "community",
  "game",
  "ai",
  "tts-1",
  "tts-2",
  "tts-3",
  "music-1",
  "music-2",
  "music-3",
  "worker",
  "tts",
];
const byService = new Map((payload.bots ?? []).map((bot) => [bot.service, bot]));
const now = Date.now();
const failures = [];
for (const service of expected) {
  const bot = byService.get(service);
  const lastSeen = bot ? Date.parse(bot.lastSeenAt) : NaN;
  if (!bot || !bot.online || !Number.isFinite(lastSeen) || now - lastSeen > maxAge) {
    failures.push(`${service}: offline or stale`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Health check passed for ${expected.length} services.`);
NODE
