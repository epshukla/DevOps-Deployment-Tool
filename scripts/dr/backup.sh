#!/usr/bin/env sh
# DeployX disaster-recovery backup (strategy: backup & restore).
#
#   SUPABASE_DB_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
#     sh scripts/dr/backup.sh            # database (public schema) + runner volumes
#   sh scripts/dr/backup.sh --volumes-only
#
# Writes backups/<timestamp>/ and keeps the newest $KEEP (default 7).
# Database: pg_dump of the public schema (projects, runs, deployments,
# documents metadata…). Auth users and Storage objects live in Supabase,
# which backs them up daily on every plan.
# Runner: every deployx-* Docker volume (object store drives, app volumes)
# as a .tar.gz, read through a throwaway container.
set -eu

KEEP="${KEEP:-7}"
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"  # pwd -W: Git Bash on Windows
DEST="$ROOT/backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DEST"

if [ "${1:-}" != "--volumes-only" ]; then
  : "${SUPABASE_DB_URL:?set SUPABASE_DB_URL (Supabase → Connect → Session pooler)}"
  echo "→ database"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump "$SUPABASE_DB_URL" --schema=public --no-owner --no-privileges | gzip > "$DEST/db-public.sql.gz"
  else
    docker run --rm -e PGURL="$SUPABASE_DB_URL" postgres:17-alpine \
      sh -c 'pg_dump "$PGURL" --schema=public --no-owner --no-privileges' | gzip > "$DEST/db-public.sql.gz"
  fi
fi

if command -v docker >/dev/null 2>&1; then
  for vol in $(docker volume ls -q --filter name=deployx-); do
    echo "→ volume $vol"
    docker run --rm -v "$vol:/v:ro" -v "$DEST:/b" alpine:3.20 tar czf "/b/vol-$vol.tar.gz" -C /v .
  done
fi

( cd "$DEST" && sha256sum * > SHA256SUMS )
echo "✓ backup in $DEST"

# Retention: delete all but the newest $KEEP backups
ls -1d "$ROOT"/backups/*/ 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
  echo "  pruning $old"; rm -rf "$old"
done
