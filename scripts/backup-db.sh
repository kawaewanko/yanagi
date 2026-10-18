#!/usr/bin/env bash
set -Eeuo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
OUTPUT="$BACKUP_DIR/yanagi-$STAMP.dump"

echo "Creating PostgreSQL backup: $OUTPUT"
docker compose -f "$COMPOSE_FILE" exec -T db pg_dump -U "${POSTGRES_USER:-yanagi}" -d "${POSTGRES_DB:-yanagi}" -Fc > "$OUTPUT"
chmod 600 "$OUTPUT"
find "$BACKUP_DIR" -type f -name 'yanagi-*.dump' -mtime "+$RETENTION_DAYS" -delete
printf '%s\n' "$OUTPUT"
