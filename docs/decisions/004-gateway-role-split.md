# ADR-004: 역할별 AgentCore Gateway 분리 / Split AgentCore Gateway by Role

## 상태: 승인됨 / Status: Accepted

## 컨텍스트 / Context
29개 MCP 도구가 포함된 단일 AgentCore Gateway는 도구 선택 정확도가 낮았습니다. LLM이 너무 많은 도구 중에서 선택해야 했기 때문에 부적절한 도구 호출과 긴 응답 시간이 발생했습니다.
(Single AgentCore Gateway with 29 MCP tools caused poor tool selection accuracy. LLM had to choose from too many tools, leading to irrelevant tool calls and longer response times.)

## 결정 / Decision
7개의 역할 기반 Gateway(Infra/IaC/Data/Security/Monitoring/Cost/Ops)로 분리하고 1개의 공유 Runtime을 사용합니다. route.ts의 키워드 기반 라우팅이 페이로드 파라미터를 통해 적절한 Gateway를 선택합니다.
(Split into 7 role-based Gateways (Infra/IaC/Data/Security/Monitoring/Cost/Ops) with 1 shared Runtime. route.ts keyword-based routing selects the appropriate Gateway via payload parameter.)

## 결과 / Consequences
- 도구 선택 정확도 향상 — 게이트웨이당 3~24개 도구 vs 기존 29개
  (Tool selection accuracy improved — 3-24 tools per gateway vs 29)
- 역할별 시스템 프롬프트가 도메인 전문성을 지원
  (Role-specific system prompts enable domain expertise)
- 추가 Runtime 비용 없음 — 단일 Runtime, 동적 Gateway
  (No additional Runtime cost — single Runtime, dynamic Gateway)
- Gateway 관리 복잡성 증가 — 7개 vs 1개
  (Gateway management complexity increased — 7 vs 1)
- Lambda 소스는 agent/lambda/에서 버전 관리
  (Lambda sources version controlled in agent/lambda/)
