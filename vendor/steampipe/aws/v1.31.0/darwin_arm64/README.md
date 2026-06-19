# Vendored Steampipe AWS Plugin

This directory contains an offline copy of the Steampipe AWS PostgreSQL FDW package for company workstation testing.

- Upstream: `turbot/steampipe-plugin-aws`
- Version: `v1.31.0`
- Platform: `darwin_arm64`
- PostgreSQL target: `pg15`
- Source URL: `https://github.com/turbot/steampipe-plugin-aws/releases/download/v1.31.0/steampipe_postgres_aws.pg15.darwin_arm64.tar.gz`
- SHA256: `03fc349ee5de50143c737ed9aa24b84b162f6442087a9aee90c3d13a582c855f`

Use:

```bash
bash scripts/15-install-vendored-steampipe-aws-plugin.sh
```

This artifact is for offline/internal installation only. Do not add AWS credentials, generated Steampipe service data, or local config files to this directory.
