#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[verify] Python unit tests"
python3 -m unittest discover -s tests/private -p 'test_*.py' -v

echo "[verify] LangGraph API health"
curl -fsS http://127.0.0.1:7000/health | python3 -m json.tool

echo "[verify] LangGraph API stream"
curl -fsS -N \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"health check"}]}' \
  http://127.0.0.1:7000/chat/stream

echo
echo "[verify] complete"
