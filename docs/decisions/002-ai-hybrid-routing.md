# ADR-002: AI 하이브리드 라우팅 / AI Hybrid Routing

## 상태: 승인됨 / Status: Accepted

## 컨텍스트 / Context
AI 어시스턴트는 코드 실행, 네트워크 문제 해결, AWS 리소스 쿼리, 일반 질문의 4가지 유형을 처리해야 합니다. 각 유형은 서로 다른 데이터 소스와 처리 방식이 필요합니다.
(AI Assistant needs to handle 4 types of questions: code execution, network troubleshooting, AWS resource queries, and general questions. Each requires different data sources and processing.)

## 결정 / Decision
키워드 감지를 기반으로 질문을 다른 백엔드로 라우팅합니다:
(Route questions to different backends based on keyword detection:)
1. 코드 실행 → Bedrock + AgentCore 코드 인터프리터
   (Code execution → Bedrock + AgentCore Code Interpreter)
2. 네트워크(ENI, 라우트, 플로우 로그) → AgentCore 런타임(Strands + Gateway MCP)
   (Network (ENI, route, flow log) → AgentCore Runtime (Strands + Gateway MCP))
3. AWS 리소스(EC2, VPC, RDS) → Steampipe 쿼리 + Bedrock Direct
   (AWS resources (EC2, VPC, RDS) → Steampipe query + Bedrock Direct)
4. 일반 → AgentCore 런타임 → Bedrock 폴백
   (General → AgentCore Runtime → Bedrock fallback)

## 이유 / Reason
- AgentCore 런타임은 격리된 microVM에서 실행 → 로컬호스트 Steampipe에 접근 불가
  (AgentCore Runtime runs in isolated microVM → cannot access localhost Steampipe)
- Steampipe는 실시간 데이터를 제공 → AWS 리소스 질문에 최적
  (Steampipe provides real-time data → best for AWS resource questions)
- Gateway MCP 도구(Lambda) → 네트워크 분석에 최적 — Reachability Analyzer, TGW 라우트, NACL
  (Gateway MCP tools (Lambda) → best for network analysis — Reachability Analyzer, TGW routes, NACLs)
- 코드 인터프리터 → 계산 및 데이터 분석에 최적
  (Code Interpreter → best for computation and data analysis)

## 결과 / Consequences
- `api/ai/route.ts`에 `needsCodeInterpreter()`, `needsAgentCore()`, `needsAWSData()` 키워드 함수 구현
  (`needsCodeInterpreter()`, `needsAgentCore()`, `needsAWSData()` keyword functions in `api/ai/route.ts`)
- AgentCore 콜드 스타트에 30-60초 소요 가능
  (AgentCore cold start can take 30-60 seconds)
- Steampipe 쿼리는 5분간 캐시됨
  (Steampipe queries cached for 5 minutes)
