#!/usr/bin/env bash
# Baut das Release-ZIP der Erweiterung (fuer "Entpackte Erweiterung laden"
# reicht der extension/-Ordner direkt -- dieses ZIP ist fuer eine GitHub-
# Release-Datei gedacht, analog zu pepperworth/nbc-files).
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
OUT="nbc-board-import-${VERSION}.zip"

rm -f "$OUT"
( cd extension && zip -r -X "../$OUT" . -x '*.DS_Store' )

echo "$OUT geschrieben ($(du -h "$OUT" | cut -f1))"
