#!/bin/bash
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$WORK_DIR/data/private-agent/langgraph-api.pid"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   AWSops Private VM - Stop Services${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

echo -e "${CYAN}[1/3] Stopping Next.js (port 3000)...${NC}"
if fuser 3000/tcp 2>/dev/null; then
    fuser -k 3000/tcp 2>/dev/null || true
    echo -e "  ${GREEN}Stopped${NC}"
else
    echo "  Not running"
fi

echo ""
echo -e "${CYAN}[2/3] Stopping private agent...${NC}"
if [ -f "$PID_FILE" ]; then
    AGENT_PID="$(cat "$PID_FILE")"
    if [ -n "$AGENT_PID" ] && kill -0 "$AGENT_PID" 2>/dev/null; then
        kill "$AGENT_PID" 2>/dev/null || true
        echo -e "  ${GREEN}Stopped${NC}"
    else
        echo "  Stale pid file removed"
    fi
    rm -f "$PID_FILE"
else
    echo "  Not running"
fi

echo ""
echo -e "${CYAN}[3/3] Stopping Steampipe service...${NC}"
if steampipe service status 2>&1 | grep -q "running"; then
    steampipe service stop --force 2>/dev/null || true
    echo -e "  ${GREEN}Stopped${NC}"
else
    echo "  Not running"
fi

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Status${NC}"
echo -e "${CYAN}=================================================================${NC}"

if fuser 3000/tcp 2>/dev/null; then
    echo -e "  ${RED}WARN${NC} Next.js still running on port 3000"
else
    echo -e "  ${GREEN}OK${NC}  Next.js stopped"
fi

if steampipe service status 2>&1 | grep -q "running"; then
    echo -e "  ${RED}WARN${NC} Steampipe still running"
else
    echo -e "  ${GREEN}OK${NC}  Steampipe stopped"
fi

echo ""
echo "  Services stopped."
echo ""
