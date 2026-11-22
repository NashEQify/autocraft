#!/bin/bash
# Consistent snapshot of the mirror database, safe while the services run.
#   deploy/backup.sh [PREFIX [KEEP]]     defaults: daily 7
# Writes $AUTOCRAFT_BACKUP_DIR/PREFIX-<UTC timestamp>.db.zst (gzip without zstd),
# then deletes all but the newest KEEP files of that prefix. The database is
# $AUTOCRAFT_DB, else mirror.db in $AUTOCRAFT_DATA_DIR; backups default to <database dir>/backups.
# SQLite only: with AUTOCRAFT_DB_URL (Postgres) the database provider keeps the backups, and this exits 3 without one.
set -euo pipefail
prefix="${1:-daily}"
keep="${2:-7}"
if [ -n "${AUTOCRAFT_DB_URL:-${CRAFT_AUTO_DB_URL:-}}" ]; then
	echo "backup skipped: AUTOCRAFT_DB_URL names a Postgres database, whose backups are the database provider's; this script snapshots SQLite only" >&2
	exit 3
fi
db="${AUTOCRAFT_DB:-${CRAFT_AUTO_DB:-}}"
data_dir="${AUTOCRAFT_DATA_DIR:-${CRAFT_AUTO_DATA_DIR:-}}"
[ -n "$db" ] || [ -z "$data_dir" ] || db="$data_dir/mirror.db"
[ -n "$db" ] || { echo "AUTOCRAFT_DB is not set" >&2; exit 1; }
dir="${AUTOCRAFT_BACKUP_DIR:-$(dirname "$db")/backups}"
umask 077
mkdir -p "$dir"
tmp="$(mktemp -p "$dir" .snapshot.XXXXXX)"
trap 'rm -f "$tmp"' EXIT
# VACUUM INTO copies inside one read transaction: writers keep going and the copy never restarts. The online backup
# API (.backup) starts over whenever another connection writes, so on a busy database it may never finish.
sqlite3 "$db" ".timeout 60000" "VACUUM INTO '$tmp'"
[ "$(sqlite3 "$tmp" 'PRAGMA quick_check')" = ok ] || { echo "snapshot failed the integrity check" >&2; exit 1; }
out="$dir/$prefix-$(date -u +%Y%m%dT%H%M%SZ).db"
if command -v zstd >/dev/null; then zstd -q -3 -T2 -o "$out.zst" "$tmp"; else gzip -1 <"$tmp" >"$out.gz"; fi
ls -1t "$dir/$prefix"-*.db.* 2>/dev/null | tail -n +$((keep + 1)) | xargs -r rm -f --
echo "snapshot: $(ls -1t "$dir/$prefix"-*.db.* | head -1)"
