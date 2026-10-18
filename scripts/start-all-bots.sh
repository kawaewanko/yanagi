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

required_vars=(
  POSTGRES_PASSWORD
  CORE_API_KEY_COMMUNITY
  CORE_API_KEY_GAME
  CORE_API_KEY_AI
  CORE_API_KEY_VOICE
  CORE_API_KEY_WORKER
  CORE_API_KEY_TTS
  COMMUNITY_BOT_TOKEN
  GAME_BOT_TOKEN
  AI_BOT_TOKEN
  VOICE_TTS_BOT_TOKEN_1
  VOICE_TTS_BOT_TOKEN_2
  VOICE_TTS_BOT_TOKEN_3
  VOICE_MUSIC_BOT_TOKEN_1
  VOICE_MUSIC_BOT_TOKEN_2
  VOICE_MUSIC_BOT_TOKEN_3
)

for name in "${required_vars[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 2
  fi
done

compose_args=(
  --profile bots
  --profile game
  --profile ai-bot
  --profile voice-tts
  --profile voice-music
  --profile tts
  --profile maintenance
)

if [[ "${AI_ENABLED:-false}" == "true" ]]; then
  echo "Starting Ollama and waiting for the configured model..."
  docker compose --profile ai up -d ollama
  docker compose --profile ai run --rm --no-deps ollama-model
fi

echo "Starting PostgreSQL, Core API, Community, Game, AI, TTS x3, Music x3, TTS worker and maintenance worker..."
docker compose "${compose_args[@]}" up --build -d

echo "Waiting for Core API health..."
for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:3000/health >/dev/null; then
    echo "Core API is healthy."
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "Core API did not become healthy. Showing service status:" >&2
    docker compose "${compose_args[@]}" ps >&2
    exit 1
  fi
  sleep 2
done

docker compose "${compose_args[@]}" ps
