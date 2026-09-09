#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ] || [ "${2:-}" = "" ]; then
  echo "Usage: $0 /path/to/zalo-user-server-backup.tar.gz /target/install/dir"
  exit 1
fi

ARCHIVE="$1"
TARGET_DIR="$2"

mkdir -p "$TARGET_DIR"
tar -xzf "$ARCHIVE" -C "$TARGET_DIR" --strip-components=1

cd "$TARGET_DIR"
docker compose up -d --build

echo "Restored and started from: $ARCHIVE"
echo "Target dir: $TARGET_DIR"
