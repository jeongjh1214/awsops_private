# Script Architecture

The private branch scripts install and run AWSops on an existing host. They must not create AWS infrastructure.

## Allowed Scripts

| Script | Purpose |
| --- | --- |
| `01-install-base.sh` | Install host runtime dependencies such as Steampipe/Powerpipe prerequisites |
| `02-setup-nextjs.sh` | Install Node dependencies and prepare the Next.js app |
| `03-build-deploy.sh` | Build and start the dashboard on the existing host |
| `04-setup-eks-access.sh` | Register kubeconfig for an existing approved cluster |
| `09-stop-all.sh`, `10-stop-all.sh` | Stop local services |
| `10-verify.sh`, `11-verify.sh` | Verify dashboard and Steampipe access |
| `13-start-private-agent.sh` | Start the local private LangGraph API |
| `13-verify-private-agent.sh` | Verify the private runtime and local chat stream |
| `test-ai-routes.py` | Exercise AI routes |

## Removed Scripts

The following script families are intentionally absent:

- CDK deploy/update
- Cognito setup
- CloudFront and Lambda@Edge setup
- AgentCore runtime, gateway, memory, and code interpreter setup
- Lambda/ECR/IAM creation for remote AgentCore tools

## Runtime Flow

```text
Existing host
  |
  |-- 01-install-base.sh
  |-- 02-setup-nextjs.sh
  |-- 03-build-deploy.sh
  |-- 13-start-private-agent.sh
  |
  v
Next.js dashboard + Steampipe + local LangGraph API
```

Configuration is read from `data/config.json`. Use `docs/examples/config.vm-private.example.json` as the starting point for `local`, `dev`, and `prod`.

## Guardrail

If a script needs a new AWS resource, do not add it to this branch. Request the resource through the approved platform/security process, then configure AWSops with the provided profile, endpoint URL, DNS name, or role ARN.
