# Configuration

## 기본 파일

```bash
mkdir -p data
cp docs/examples/config.vm-private.example.json data/config.json
```

`data/config.json`은 git에 올리지 않는다. profile 이름, endpoint URL, 내부 API 설정은 환경별로 직접 관리한다.

## Environment 선택

```json
{
  "activeEnvironment": "local"
}
```

`activeEnvironment` 값은 `local`, `dev`, `prod` 중 하나다.

## Environment 설정

```json
{
  "environments": {
    "local": {
      "networkMode": "external-explicit-vpce",
      "endpointMode": "explicit",
      "bedrockProfile": "bedrock-local-profile",
      "awsProfile": "awsops-local-profile",
      "identityCenterProfile": "identity-center-local-profile",
      "endpointUrls": {
        "bedrock-runtime": "https://vpce-xxxxxxxx.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com",
        "identitystore": "https://vpce-xxxxxxxx.identitystore.ap-northeast-2.vpce.amazonaws.com",
        "s3": "https://vpce-xxxxxxxx.s3.ap-northeast-2.vpce.amazonaws.com",
        "sso-admin": "https://vpce-xxxxxxxx.sso.ap-northeast-2.vpce.amazonaws.com",
        "sts": "https://vpce-xxxxxxxx.sts.ap-northeast-2.vpce.amazonaws.com"
      }
    }
  }
}
```

## Profile 분리

| 설정 | 용도 |
| --- | --- |
| `awsProfile` | 일반 AWS resource 조회 |
| `bedrockProfile` | Bedrock Runtime 호출 |
| `identityCenterProfile` | IAM Identity Center 감사 fallback |
| `identityAudit.awsProfile` | IAM Identity Center 감사 우선 profile |

Identity 감사 profile 우선순위:

1. `identityAudit.awsProfile`
2. `environments.<active>.identityCenterProfile`
3. `environments.<active>.awsProfile`

## Identity 감사 설정

```json
{
  "identityAudit": {
    "enabled": false,
    "region": "ap-northeast-2",
    "awsProfile": "identity-audit-profile",
    "schedule": {
      "dayOfWeek": 2,
      "hourKst": 10,
      "timezone": "Asia/Seoul"
    },
    "organizationApi": {
      "baseUrl": "https://knock-api.kakaopay.com/papi/v1/krew",
      "apiKeyEnv": "KREW_API_KEY",
      "lookupField": "displayName",
      "concurrency": 10,
      "timeoutMs": 5000,
      "retryCount": 2
    }
  }
}
```

`KREW_API_KEY`는 환경변수로만 설정한다.

```bash
export KREW_API_KEY='...'
```

API Key를 `data/config.json`, git, log에 남기지 않는다.

## AWS Query Service allowlist

```json
{
  "queryPolicy": {
    "enabledServices": [
      "ec2",
      "lambda",
      "ecs",
      "vpc",
      "ebs",
      "s3",
      "rds",
      "dynamodb",
      "elasticache",
      "cloudwatch",
      "iam"
    ],
    "allowComplianceBenchmark": false
  }
}
```

이 목록은 Dashboard, Cache Warmer, service page, AI Steampipe query에 공통 적용된다. 목록에 없는 AWS service query는 Steampipe 연결 전에 차단되고 관련 Sidebar 메뉴와 Dashboard card는 숨겨진다. Bedrock inference와 STS, IAM Identity Center 감사처럼 application 운영에 필요한 명시적 SDK 호출은 이 resource query allowlist와 별도로 관리한다.

`allowComplianceBenchmark`는 Powerpipe CIS benchmark처럼 여러 AWS service를 폭넓게 조회하는 기능을 별도로 제어한다. 기본값은 `false`이며, `false`일 때 메뉴를 숨기고 benchmark 실행 API를 차단한다.

설정을 변경한 뒤 Next.js application과 private agent를 재시작한다.

## Asset Inventory 설정

```json
{
  "assetInventory": {
    "enabled": true,
    "dbProvider": "sqlite",
    "sqlitePath": "data/awsops.db",
    "syncOnDemandOnly": true,
    "adminTokenHash": "",
    "supportedResourceTypes": [
      "ec2_instance",
      "s3_bucket"
    ]
  }
}
```

현재 기본 sync 대상은 `ec2_instance`, `s3_bucket`이다. 추가 resource type은 normalizer, query, endpoint 경로가 준비된 뒤 allowlist에 넣는다.

## Endpoint URL 검증

STS:

```bash
aws sts get-caller-identity \
  --profile awsops-local-profile \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.sts.ap-northeast-2.vpce.amazonaws.com
```

S3:

```bash
AWS_PROFILE=awsops-local-profile aws s3api list-buckets \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.s3.ap-northeast-2.vpce.amazonaws.com
```

Bedrock Runtime:

```bash
AWS_PROFILE=bedrock-local-profile aws bedrock-runtime invoke-model \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.bedrock-runtime.ap-northeast-2.vpce.amazonaws.com \
  --model-id '<model-id-or-inference-profile-arn>' \
  --content-type application/json \
  --accept application/json \
  --cli-binary-format raw-in-base64-out \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[{"role":"user","content":"ping"}]}' \
  /tmp/awsops-bedrock-response.json
```

IAM Identity Center:

```bash
aws sso-admin list-instances \
  --profile identity-audit-profile \
  --region ap-northeast-2 \
  --endpoint-url https://vpce-xxxxxxxx.sso.ap-northeast-2.vpce.amazonaws.com
```

## TLS hostname 주의사항

`endpointUrls`에는 private IP가 아니라 VPCE DNS hostname을 넣는다. TLS 검증은 hostname 기준으로 수행되므로 임의 IP를 넣으면 인증서 hostname mismatch가 발생할 수 있다.
