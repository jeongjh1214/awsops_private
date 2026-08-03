#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export AWSOPS_CONFIG="${AWSOPS_CONFIG:-data/config.json}"
LANGGRAPH_HOST="${LANGGRAPH_HOST:-127.0.0.1}"
LANGGRAPH_PORT="${LANGGRAPH_PORT:-7000}"
LANGGRAPH_API_URL="${LANGGRAPH_API_URL:-http://${LANGGRAPH_HOST}:${LANGGRAPH_PORT}}"

STATE_DIR="data/private-agent"
LOG_FILE="${STATE_DIR}/langgraph-api.log"
PID_FILE="${STATE_DIR}/langgraph-api.pid"

mkdir -p "$STATE_DIR"

if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE")"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    echo "[private-agent] already running with pid ${existing_pid}"
    curl --max-time 5 -fsS "${LANGGRAPH_API_URL}/health"
    echo
    echo "[private-agent] started"
    exit 0
  fi
fi

echo "[private-agent] starting MCP server on stdio is handled by LangGraph in later phases"
echo "[private-agent] starting LangGraph API on ${LANGGRAPH_API_URL}"

if [ "${SKIP_PRIVATE_AGENT_PIP_INSTALL:-false}" != "true" ]; then
  echo "[private-agent] installing Python dependencies from agent/requirements-private.txt"
  python3 -m pip install -r agent/requirements-private.txt
fi

nohup python3 -m uvicorn agent.langgraph_api:app \
  --host "$LANGGRAPH_HOST" \
  --port "$LANGGRAPH_PORT" \
  > "$LOG_FILE" 2>&1 &

echo "$!" > "$PID_FILE"
sleep 2

if ! curl --max-time 5 -fsS "${LANGGRAPH_API_URL}/health"; then
  echo
  echo "[private-agent] startup failed; removing stale pid file"
  rm -f "$PID_FILE"
  echo "[private-agent] recent log output from ${LOG_FILE}:"
  tail -n 40 "$LOG_FILE" || true
  exit 1
fi

echo
echo "[private-agent] started"
