# AWSops 내재화 개요

## 목적

AWSops는 내부망에서 AWS 운영 현황을 조회하고, 클라우드 자산관리와 감사 대응 데이터를 관리하기 위한 private VM 기반 대시보드다.

이 브랜치는 금융권 내부망 운영을 전제로 한다. AWSops는 애플리케이션과 런타임만 배포하며, AWS 인프라를 생성하거나 변경하지 않는다.

## 핵심 원칙

- AWS 리소스 생성, 수정, 삭제 금지
- CDK, CloudFormation, Terraform 기반 배포 경로 제외
- CloudFront, Cognito, Lambda@Edge, Bedrock AgentCore 사용 제외
- 기존 VM, 기존 AWS profile, 기존 VPC Endpoint만 사용
- local, dev, prod 환경 차이는 `data/config.json`으로만 제어
- AWS API 호출은 가능한 경우 configured VPC Endpoint 경로를 사용
- AI 응답은 저장된 DB 또는 명시적으로 수집된 데이터만 근거로 사용

## 제공 기능

| 영역 | 기능 | 현재 상태 |
| --- | --- | --- |
| Private dashboard | Next.js 기반 내부 운영 화면 | 구현 |
| Private AI | local MCP + LangGraph + Bedrock Runtime | 구현 |
| Cloud Asset Inventory | EC2, S3 등 cloud resource 원장화 | 구현 |
| S3 관리대장 | S3 bucket별 담당조직, 용도, 개인정보/보존기간 관리 | 구현 |
| IAM Identity Center 감사 | 부서 이동자 중 AWS 권한 잔존자 탐지 | 구현 |
| Identity 감사 AI 질의 | 저장된 finding 기반 AI 답변 | 설계 완료, 구현 예정 |

## 운영 방식

AWSops는 다음 세 환경을 같은 코드로 지원한다.

| 환경 | 실행 위치 | 네트워크 방식 | credential |
| --- | --- | --- | --- |
| `local` | 개인/회사 PC | explicit VPC Endpoint URL | `~/.aws/credentials` profile |
| `dev` | 내부 개발 서버 | explicit VPC Endpoint URL | 서버 local profile |
| `prod` | 기존 AWS VM | private DNS 또는 hybrid endpoint | VM/profile |

`npm run dev`는 Next.js 개발 서버를 의미한다. AWSops의 `dev` 환경 선택은 `data/config.json`의 `activeEnvironment`로만 결정된다.

## 금지 사항

AWSops repository 또는 배포 스크립트는 다음을 수행하면 안 된다.

- VPC, subnet, route table, security group, VPC Endpoint 생성
- ALB, NAT Gateway, Transit Gateway 생성
- CloudFront distribution, Lambda@Edge 생성
- Cognito user pool 또는 app client 생성
- Bedrock AgentCore runtime/gateway/memory/code interpreter 생성
- IAM role/policy/user/access key 생성
- 운영 환경에서 임의의 AWS resource mutation 수행

필요한 AWS 리소스는 승인된 내부 절차로 별도 생성하고, AWSops에는 profile, endpoint URL, DNS name, role name 같은 결과값만 설정한다.

## 주요 설정 파일

| 파일 | 용도 |
| --- | --- |
| `data/config.json` | 환경 선택, profile, endpoint URL, 기능 설정 |
| `docs/examples/config.vm-private.example.json` | private VM 설정 예시 |
| `data/awsops.db` | Cloud Asset, S3 관리대장, Identity 감사 SQLite DB |
| `~/.aws/credentials` | AWSops, Bedrock, Identity Center profile |
| `~/.steampipe/config/awsops-private.spc` | AWSops용 Steampipe AWS connection |

## 관련 문서

- `docs/wiki/01-architecture.md`
- `docs/wiki/02-configuration.md`
- `docs/wiki/03-cloud-assets-and-s3-governance.md`
- `docs/wiki/04-identity-center-org-audit.md`
- `docs/wiki/05-operations-runbook.md`
- `docs/wiki/06-current-status-and-roadmap.md`
