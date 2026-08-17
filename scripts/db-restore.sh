#!/usr/bin/env bash
# Restores a PostgreSQL backup produced by db-backup.sh.
#
# Usage: npm run db:restore -- backups/svp-erp-20260101-120000.dump
#
# SAFETY: this will NOT run without an explicit "yes" confirmation, and it
# verifies the backup's checksum before touching anything. It restores into
# whatever DATABASE_URL currently points to — for a real disaster-recovery
# drill, point DATABASE_URL at a temporary/scratch database first, never
# directly at production, until you've confirmed the restore is clean.
set -euo pipefail

if [ -f .env ]; then set -a; source .env; set +a; fi

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: npm run db:restore -- <path-to-backup.dump>" >&2
  exit 1
fi
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: backup file not found: $BACKUP_FILE" >&2
  exit 1
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  exit 1
fi

if [ -f "$BACKUP_FILE.sha256" ]; then
  echo "Verifying backup checksum..."
  EXPECTED=$(awk '{print $1}' "$BACKUP_FILE.sha256")
  ACTUAL=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "ERROR: checksum mismatch! Backup file may be corrupted or tampered with." >&2
    echo "Expected: $EXPECTED" >&2
    echo "Actual:   $ACTUAL" >&2
    exit 1
  fi
  echo "Checksum verified OK."
else
  echo "WARNING: no .sha256 file found alongside this backup — skipping checksum verification."
fi

echo ""
echo "=========================================================================="
echo " WARNING: This will REPLACE ALL DATA in the target database with the"
echo " contents of: $BACKUP_FILE"
echo " THIS CANNOT BE UNDONE unless you have a separate backup of the current state."
echo "=========================================================================="
read -r -p "Type 'yes' to proceed: " CONFIRM
if [ "$CONFIRM" != "yes" ]; then
  echo "Aborted — no changes made."
  exit 1
fi

echo "Restoring..."
PG_RESTORE_URL="${DATABASE_URL%%\?*}"
pg_restore -d "$PG_RESTORE_URL" --clean --if-exists "$BACKUP_FILE"
echo "Restore complete. Verify the application starts correctly and data looks right before considering this final."
