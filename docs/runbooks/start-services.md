# Runbook: 서비스 시작 / Start Services

## 빠른 시작 / Quick Start
```bash
bash scripts/09-start-all.sh
```

## 수동 시작 / Manual Start

### 1. Steampipe
```bash
bash scripts/16-start-steampipe-private.sh
steampipe service status --show-password
```

### 2. Next.js
```bash
cd /home/ec2-user/awsops
PORT=3000 npm run start &
```

### 3. Private agent
```bash
bash scripts/13-start-private-agent.sh
```

### 4. 검증 / Verify
```bash
curl -s http://localhost:3000/awsops  # 200 응답이 와야 함 (should return 200)
bash scripts/11-verify.sh             # 전체 점검 (full check)
```

## 문제 해결 / Troubleshooting
- 포트 3000이 사용 중인 경우 (Port 3000 in use): `fuser -k 3000/tcp`
- Steampipe가 시작되지 않는 경우 (Steampipe won't start): `bash scripts/16-start-steampipe-private.sh`
- 비밀번호 불일치 (Password mismatch): `bash scripts/02-setup-nextjs.sh` (비밀번호 재동기화 / re-syncs password)
