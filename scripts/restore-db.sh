#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${CONFIRM_RESTORE:-}" != "YES" ]]; then
  echo 'Refusing to restore. Set CONFIRM_RESTORE=YES explicitly.' >&2
  exit 2
fi
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: CONFIRM_RESTORE=YES $0 backups/yanagi-<timestamp>.dump" >&2
  exit 2
fi

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
DUMP_FILE="$1"

echo "Restoring $DUMP_FILE into the configured database. Existing data may be overwritten."
docker compose -f "$COMPOSE_FILE" exec -T db pg_restore \
  -U "${POSTGRES_USER:-yanagi}" \
  -d "${POSTGRES_DB:-yanagi}" \
  --clean --if-exists --exit-on-error < "$DUMP_FILE"
