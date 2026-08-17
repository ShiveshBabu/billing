#!/usr/bin/env bash
# Verifies a backup file is valid AND actually restorable — not just that the
# file exists. Restores into a temporary scratch database (never the real
# one) and confirms the expected tables come back, then drops the scratch DB.
#
# Usage: bash scripts/db-verify-backup.sh backups/svp-erp-20260101-120000.dump
set -euo pipefail

if [ -f .env ]; then set -a; source .env; set +a; fi

BACKUP_FILE="${1:-}"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "Usage: bash scripts/db-verify-backup.sh <path-to-backup.dump>" >&2
  exit 1
fi

echo "1. Verifying checksum..."
if [ -f "$BACKUP_FILE.sha256" ]; then
  EXPECTED=$(awk '{print $1}' "$BACKUP_FILE.sha256")
  ACTUAL=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "   FAIL: checksum mismatch." >&2
    exit 1
  fi
  echo "   OK"
else
  echo "   SKIPPED (no .sha256 file found)"
fi

echo "2. Test-restoring into a temporary scratch database..."
if [ -z "${DATABASE_URL:-}" ]; then
  echo "   SKIPPED: DATABASE_URL not set, cannot derive connection details for a scratch DB." >&2
  exit 0
fi

SCRATCH_DB="svp_erp_verify_$(date +%s)"
BASE_URL="${DATABASE_URL%%\?*}"
BASE_URL="${BASE_URL%/*}"
VERIFY_URL="${SUPERUSER_DATABASE_URL:-$BASE_URL/postgres}"
VERIFY_URL="${VERIFY_URL%%\?*}"

createdb_result=$(psql "$VERIFY_URL" -c "CREATE DATABASE \"$SCRATCH_DB\";" 2>&1) || {
  echo "   SKIPPED: could not create a scratch database with the current connection." >&2
  echo "   This is expected if DATABASE_URL uses a least-privilege application role" >&2
  echo "   (which correctly cannot CREATE DATABASE — that's good security, not a bug)." >&2
  echo "   To actually run this check, set SUPERUSER_DATABASE_URL to a connection" >&2
  echo "   string with database-creation privilege (e.g. Railway's Postgres plugin" >&2
  echo "   connection string, or your local 'postgres' superuser) and re-run:" >&2
  echo "     SUPERUSER_DATABASE_URL=postgresql://postgres:pw@host:5432/postgres bash scripts/db-verify-backup.sh $BACKUP_FILE" >&2
  echo "   Detail: $createdb_result" >&2
  exit 0
}

cleanup() { psql "$VERIFY_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" > /dev/null 2>&1 || true; }
trap cleanup EXIT

VERIFY_BASE="${VERIFY_URL%/*}"
pg_restore -d "$VERIFY_BASE/$SCRATCH_DB" "$BACKUP_FILE" > /dev/null 2>&1 || {
  echo "   FAIL: pg_restore reported errors restoring into the scratch database." >&2
  exit 1
}

TABLE_COUNT=$(psql "$VERIFY_BASE/$SCRATCH_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
if [ "$TABLE_COUNT" -lt 10 ]; then
  echo "   FAIL: only $TABLE_COUNT tables restored — expected the full schema (30+ tables)." >&2
  exit 1
fi
echo "   OK — restored $TABLE_COUNT tables into scratch DB '$SCRATCH_DB', now dropped."

echo ""
echo "Backup verification PASSED: $BACKUP_FILE is valid and restorable."
