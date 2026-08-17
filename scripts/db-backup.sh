#!/usr/bin/env bash
# Real PostgreSQL backup — not the in-app browser JSON export, which is a
# convenience data export only, never a substitute for this.
#
# Usage: npm run db:backup
# Requires DATABASE_URL to be set (reads it from .env if present).
set -euo pipefail

if [ -f .env ]; then set -a; source .env; set +a; fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set. Set it in .env or the environment before running this script." >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIRECTORY:-./backups}"
mkdir -p "$BACKUP_DIR"

# Prisma-style connection strings include a ?schema=public query parameter
# that pg_dump (plain libpq) doesn't understand — strip it before use.
PG_DUMP_URL="${DATABASE_URL%%\?*}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/svp-erp-$TIMESTAMP.dump"

echo "Backing up database to $BACKUP_FILE ..."
pg_dump "$PG_DUMP_URL" -F c -f "$BACKUP_FILE"

CHECKSUM=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
echo "$CHECKSUM  $(basename "$BACKUP_FILE")" > "$BACKUP_FILE.sha256"

cat > "$BACKUP_FILE.meta.json" <<EOF
{
  "file": "$(basename "$BACKUP_FILE")",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sha256": "$CHECKSUM",
  "sizeBytes": $(stat -c%s "$BACKUP_FILE" 2>/dev/null || stat -f%z "$BACKUP_FILE")
}
EOF

echo "Backup complete: $BACKUP_FILE"
echo "Checksum: $CHECKSUM"
echo ""

# --- Retention: keep the most recent N backups, delete older ones ---
RETENTION_COUNT="${BACKUP_RETENTION_COUNT:-14}"
echo "Applying retention policy (keeping the most recent $RETENTION_COUNT backups)..."
ls -1t "$BACKUP_DIR"/svp-erp-*.dump 2>/dev/null | tail -n +$((RETENTION_COUNT + 1)) | while read -r old; do
  echo "  Removing old backup: $old"
  rm -f "$old" "$old.sha256" "$old.meta.json"
done

echo "Done. Verify this backup is actually restorable with:"
echo "  bash scripts/db-verify-backup.sh $BACKUP_FILE"
