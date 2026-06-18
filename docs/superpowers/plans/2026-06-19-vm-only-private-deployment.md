# VM-Only Private Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove CDK and AWS resource-creation deployment paths so AWSops private mode installs only application/runtime software on existing local, development, or production VMs.

**Architecture:** The private branch treats infrastructure as externally managed. AWSops runs on a pre-provisioned host with existing AWS credentials, existing VPC endpoints, Steampipe, Next.js, and a local MCP/LangGraph agent. Environment differences are expressed only in `data/config.json` through `local`, `dev`, and `prod` entries.

**Tech Stack:** Next.js 14, Steampipe, Python FastAPI/LangGraph runtime, shell scripts, JSON config.

---

### Task 1: Remove Infrastructure-as-Code Assets

**Files:**
- Delete: `infra-cdk/`
- Delete: AWS resource creation scripts in `scripts/`

- [ ] **Step 1: Delete CDK project**

Run: `rm -rf infra-cdk`

Expected: `rg --files infra-cdk` returns no files.

- [ ] **Step 2: Delete scripts that create AWS resources**

Run:
```bash
rm -f \
  scripts/00-deploy-infra.sh \
  scripts/00-update-infra.sh \
  scripts/05-setup-cognito.sh \
  scripts/06-setup-agentcore.sh \
  scripts/06a-setup-agentcore-runtime.sh \
  scripts/06b-setup-agentcore-gateway.sh \
  scripts/06c-setup-agentcore-tools.sh \
  scripts/06d-setup-agentcore-interpreter.sh \
  scripts/06e-setup-agentcore-config.sh \
  scripts/06e-setup-agentcore-memory.sh \
  scripts/06f-setup-agentcore-memory.sh \
  scripts/06f-setup-opencost-interactive.sh \
  scripts/06f-setup-opencost.sh \
  scripts/07-setup-cloudfront-auth.sh \
  scripts/07-setup-opencost-interactive.sh \
  scripts/07-setup-opencost.sh \
  scripts/08-setup-cloudfront-auth.sh \
  scripts/08-start-all.sh \
  scripts/11-setup-multi-account.sh \
  scripts/12-setup-multi-account.sh \
  scripts/install-all.sh \
  scripts/setup.sh
```

Expected: listed scripts are absent; VM install/start/verify scripts remain.

### Task 2: Add VM-Only Config Example

**Files:**
- Create: `docs/examples/config.vm-private.example.json`

- [ ] **Step 1: Add a local/dev/prod config sample**

The sample must define `activeEnvironment`, `local`, `dev`, `prod`, `endpointUrls`, `bedrockProfile`, `awsProfile`, and `agent.provider: local-mcp-langgraph`.

- [ ] **Step 2: Verify JSON syntax**

Run: `python3 -m json.tool docs/examples/config.vm-private.example.json >/dev/null`

Expected: exit 0.

### Task 3: Replace Deployment Documentation

**Files:**
- Replace: `README.md`
- Replace: `docs/architecture.md`
- Replace: `docs/INSTALL_GUIDE.md`
- Replace: `scripts/ARCHITECTURE.md`

- [ ] **Step 1: Document VM-only architecture**

Describe browser/internal proxy to existing VM, Next.js, Steampipe, local LangGraph API, MCP server, existing AWS credentials, and existing VPCE endpoints.

- [ ] **Step 2: Document local/dev/prod environments**

State that local and dev use explicit VPCE URLs, while prod may use private DNS or hybrid mode depending on the existing VM network.

- [ ] **Step 3: Document prohibited actions**

State that this branch must not create CDK stacks, VPCs, endpoints, ALBs, CloudFront distributions, Cognito pools, AgentCore runtimes, Lambdas, ECR repos, or IAM roles.

### Task 4: Update UI Copy That Points to Removed Infra Templates

**Files:**
- Modify: `src/app/accounts/page.tsx`

- [ ] **Step 1: Remove CloudFormation template guidance**

Replace target-account role creation instructions with a message that target roles must be pre-provisioned by the platform/security team, and AWSops only stores profile/role metadata.

- [ ] **Step 2: Build**

Run: `npm run build`

Expected: exit 0, with only pre-existing warnings.

### Task 5: Verify and Commit

**Files:**
- All changed files.

- [ ] **Step 1: Run verification**

Run:
```bash
python3 -m unittest discover -s tests/private -p 'test_*.py' -v
bash -n scripts/*.sh
python3 -m json.tool docs/examples/config.vm-private.example.json >/dev/null
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Confirm no CDK/resource-creation references remain in active docs/scripts**

Run:
```bash
test ! -d infra-cdk
! rg -n "infra-cdk|cdk deploy|CDK infrastructure|setup-cognito|setup-agentcore|setup-cloudfront-auth" README.md docs/architecture.md docs/INSTALL_GUIDE.md scripts/ARCHITECTURE.md scripts
```

Expected: exit 0.

- [ ] **Step 3: Commit**

Run:
```bash
git add -A
git commit -m "refactor: remove cdk infrastructure deployment path"
git push
```

Expected: commit and push succeed.
