#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

export AWSOPS_CONFIG="${AWSOPS_CONFIG:-data/config.json}"

mkdir -p data/private-agent

echo "[private-agent] starting MCP server on stdio is handled by LangGraph in later phases"
echo "[private-agent] starting LangGraph API on 127.0.0.1:7000"

nohup python3 -m uvicorn agent.langgraph_api:app \
  --host 127.0.0.1 \
  --port 7000 \
  > data/private-agent/langgraph-api.log 2>&1 &

echo "$!" > data/private-agent/langgraph-api.pid
sleep 2

curl -fsS http://127.0.0.1:7000/health
echo
echo "[private-agent] started"
