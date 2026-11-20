#!/usr/bin/env bash
# =====================================================================
# VetMCP — сборка MCPB-бандла (MCP Bundle, desktop-расширение).
# manifest.json (спека 0.3) + сервер одним файлом → dist/vetmcp.mcpb.
# Бандл публикуется ассетом релиза и раздаётся через официальный
# реестр MCP (registryType: mcpb в server.json).
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

STAGE=".mcpb-stage"
rm -rf "$STAGE" dist
mkdir -p "$STAGE/server" dist

cp mcpb/manifest.json "$STAGE/"
cp vetmcp.mjs "$STAGE/server/"
cp LICENSE "$STAGE/"

# manifest.json обязан лежать в корне архива
(cd "$STAGE" && zip -q -r -X ../dist/vetmcp.mcpb .)
rm -rf "$STAGE"

echo "— dist/vetmcp.mcpb"
sha256sum dist/vetmcp.mcpb
