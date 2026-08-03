#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

LANGGRAPH_HOST="${LANGGRAPH_HOST:-127.0.0.1}"
LANGGRAPH_PORT="${LANGGRAPH_PORT:-7000}"
LANGGRAPH_API_URL="${LANGGRAPH_API_URL:-http://${LANGGRAPH_HOST}:${LANGGRAPH_PORT}}"

echo "[verify] Python unit tests"
python3 -m unittest discover -s tests/private -p 'test_*.py' -v

echo "[verify] expecting LangGraph API to be running at ${LANGGRAPH_API_URL}"
echo "[verify] LangGraph API health"
curl --max-time 5 -fsS "${LANGGRAPH_API_URL}/health" | python3 -m json.tool

echo "[verify] LangGraph API stream"
curl --max-time 10 -fsS -N \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"health check"}]}' \
  "${LANGGRAPH_API_URL}/chat/stream"

echo
echo "[verify] complete"
