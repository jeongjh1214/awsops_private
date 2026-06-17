# ECS Container Cost / ECS 컨테이너 비용

## Role / 역할
ECS Task cost analysis page using Fargate pricing and CloudWatch Container Insights.
Fargate 가격 및 CloudWatch Container Insights 기반 ECS Task 비용 분석 페이지.

## Files / 파일
- `page.tsx` — ECS Container Cost dashboard (StatsCards, charts, task table, calculation basis)

## Data Sources / 데이터 소스
- Steampipe `aws_ecs_task` — Task metadata (CPU, memory, launch type)
- CloudWatch `AWS/ECS/ContainerInsights` — Container Insights metrics
- `data/config.json` `fargatePricing` — Configurable Fargate unit pricing

## Cost Calculation / 비용 계산
- Fargate: (CPU units / 1024) x vCPU hourly rate + (Memory MB / 1024) x GB hourly rate
- EC2 launch type: displayed as N/A (requires node cost allocation)
- Default pricing: ap-northeast-2 ($0.04048/vCPU-hr, $0.004445/GB-hr)

## Related / 관련
- EKS Container Cost: `src/app/eks-container-cost/` (OpenCost + Request-based)
- API: `src/app/api/container-cost/route.ts`
- Queries: `src/lib/queries/container-cost.ts`
