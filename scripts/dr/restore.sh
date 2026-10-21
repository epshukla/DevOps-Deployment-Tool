#!/usr/bin/env sh
# Restore a DeployX backup made by backup.sh.
#
#   SUPABASE_DB_URL=... sh scripts/dr/restore.sh backups/<timestamp>          # db + volumes
#   sh scripts/dr/restore.sh backups/<timestamp> --volumes-only
#
# Database: run the migrations on the (new) project first
# (npx supabase db push), then this loads the data. Volumes: stop the
# runner first; existing volumes with the same names are overwritten.
set -eu

SRC="${1:?usage: restore.sh backups/<timestamp> [--volumes-only]}"
SRC="$(cd "$SRC" && (pwd -W 2>/dev/null || pwd))"
( cd "$SRC" && sha256sum -c SHA256SUMS ) || { echo "checksum mismatch — refusing to restore"; exit 1; }

if [ "${2:-}" != "--volumes-only" ] && [ -f "$SRC/db-public.sql.gz" ]; then
  : "${SUPABASE_DB_URL:?set SUPABASE_DB_URL}"
  echo "→ database"
  if command -v psql >/dev/null 2>&1; then
    gunzip -c "$SRC/db-public.sql.gz" | psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 --single-transaction
  else
    gunzip -c "$SRC/db-public.sql.gz" | docker run --rm -i -e PGURL="$SUPABASE_DB_URL" postgres:17-alpine \
      sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 --single-transaction'
  fi
fi

for archive in "$SRC"/vol-*.tar.gz; do
  [ -e "$archive" ] || continue
  vol="$(basename "$archive" .tar.gz | sed 's/^vol-//')"
  echo "→ volume $vol"
  docker volume create "$vol" >/dev/null
  docker run --rm -v "$vol:/v" -v "$SRC:/b:ro" alpine:3.20 \
    sh -c "find /v -mindepth 1 -delete && tar xzf /b/$(basename "$archive") -C /v"
done
echo "✓ restored from $SRC"
