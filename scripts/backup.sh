#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.openclaw/workspace/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/zalo-user-server-backup-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

cd "$PROJECT_DIR"

tar \
  --exclude='./node_modules' \
  --exclude='./.DS_Store' \
  --exclude='./*.log' \
  --exclude='./tmp' \
  -czf "$ARCHIVE" \
  .

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'zalo-user-server-backup-*.tar.gz' ! -path "$ARCHIVE" -delete

echo "Backup created: $ARCHIVE"
echo "Older backups removed from: $BACKUP_DIR"
