#!/usr/bin/env bash
# Sync frontend source → dist/ folder (run once after editing src/ or index.html)
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$SCRIPT_DIR/dist/src"
cp "$SCRIPT_DIR/index.html"    "$SCRIPT_DIR/dist/index.html"
cp "$SCRIPT_DIR/src/main.js"   "$SCRIPT_DIR/dist/src/main.js"
cp "$SCRIPT_DIR/src/style.css" "$SCRIPT_DIR/dist/src/style.css"
echo "dist/ synced."
