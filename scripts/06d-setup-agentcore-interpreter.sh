#!/bin/bash
set -e
################################################################################
#                                                                              #
#   Step 6d: AgentCore Code Interpreter Setup                                  #
#                                                                              #
#   Creates:                                                                   #
#     1. Code Interpreter (Python sandbox for data analysis)                   #
#                                                                              #
#   Known issues handled:                                                      #
#     - Name must match [a-zA-Z][a-zA-Z0-9_] (no hyphens)                    #
#     - networkConfiguration with networkMode is required                      #
#                                                                              #
################################################################################

# -- Colors & common variables ------------------------------------------------
GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; NC='\033[0m'
WORK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")

echo ""
echo -e "${CYAN}=================================================================${NC}"
echo -e "${CYAN}   Step 6d: AgentCore Code Interpreter Setup${NC}"
echo -e "${CYAN}=================================================================${NC}"
echo ""
echo "  Region:  $REGION"
echo "  Account: $ACCOUNT_ID"
echo ""

# -- [1/1] Create Code Interpreter --------------------------------------------
#   KNOWN ISSUE: Name cannot contain hyphens. Use underscores.
#   KNOWN ISSUE: --network-configuration with networkMode is required.
echo -e "${CYAN}[1/1] Creating Code Interpreter...${NC}"
echo -e "  ${YELLOW}NOTE: Name uses underscores (hyphens not allowed)${NC}"
echo -e "  ${YELLOW}NOTE: networkConfiguration with networkMode is required${NC}"

CI_RESULT=$(aws bedrock-agentcore-control create-code-interpreter \
    --name awsops_code_interpreter \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --region "$REGION" --output json 2>&1) || true

CI_ID=$(echo "$CI_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('codeInterpreterId',''))" 2>/dev/null || echo "N/A")
CI_STATUS=$(echo "$CI_RESULT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "N/A")

if [ "$CI_ID" = "" ] || [ "$CI_ID" = "N/A" ]; then
    echo -e "  ${YELLOW}WARN: Code Interpreter creation may have failed.${NC}"
    echo "  $CI_RESULT"
else
    echo "  Code Interpreter ID: $CI_ID"
    echo "  Status:              $CI_STATUS"
fi

# -- Summary -------------------------------------------------------------------
echo ""
echo -e "${GREEN}=================================================================${NC}"
echo -e "${GREEN}   Step 6d Complete: Code Interpreter configured${NC}"
echo -e "${GREEN}=================================================================${NC}"
echo ""
echo "  Code Interpreter ID: $CI_ID"
echo "  Network Mode:        PUBLIC"
echo ""
echo "  AgentCore 전체 설치 완료!"
echo "    6a: Runtime     (Strands agent + ECR + Endpoint)"
echo "    6b: Gateway     (MCP protocol)"
echo "    6c: Tools       (4 Lambda + 4 Gateway Targets)"
echo "    6d: Interpreter (Code execution sandbox)"
echo ""
