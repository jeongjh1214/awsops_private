#!/bin/bash
set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$WORK_DIR"

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   AWSops Private VM - Start Services${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""

echo -e "${CYAN}[1/3] Starting Steampipe service (port 9193)...${NC}"
bash scripts/16-start-steampipe-private.sh
echo -e "  ${GREEN}Started${NC}"

echo ""
echo -e "${CYAN}[2/3] Starting Next.js production server (port 3000)...${NC}"
fuser -k 3000/tcp 2>/dev/null || true
sleep 1
nohup sh -c "PORT=3000 npm run start" > /tmp/awsops-server.log 2>&1 &
sleep 3
echo -e "  ${GREEN}Started (log: /tmp/awsops-server.log)${NC}"

echo ""
echo -e "${CYAN}[3/3] Starting local private agent...${NC}"
bash scripts/13-start-private-agent.sh

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Service Status${NC}"
echo -e "${CYAN}=================================================================${NC}"

if steampipe service status 2>&1 | grep -q "running"; then
    echo -e "  ${GREEN}OK${NC}  Steampipe          port 9193"
else
    echo -e "  ${RED}FAIL${NC}  Steampipe          NOT RUNNING"
fi

HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/awsops 2>/dev/null || true)
if [ "$HTTP" = "200" ]; then
    echo -e "  ${GREEN}OK${NC}  Next.js            port 3000"
else
    echo -e "  ${RED}FAIL${NC}  Next.js            HTTP ${HTTP:-000}"
fi

AGENT_HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:7000/health 2>/dev/null || true)
if [ "$AGENT_HTTP" = "200" ]; then
    echo -e "  ${GREEN}OK${NC}  Private agent     port 7000"
else
    echo -e "  ${YELLOW}WARN${NC}  Private agent     HTTP ${AGENT_HTTP:-000}"
fi

echo ""
echo -e "${CYAN}Access URL:${NC} http://localhost:3000/awsops"
echo -e "${YELLOW}Note:${NC} This script does not detect or create CloudFront, Cognito, ALB, AgentCore, Lambda, ECR, IAM, or VPC resources."
echo ""
