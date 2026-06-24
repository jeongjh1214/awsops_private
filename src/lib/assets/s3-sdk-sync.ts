import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { fromIni } from '@aws-sdk/credential-provider-ini';
import { getConfig, type AccountConfig, type PrivateEnvironmentConfig } from '../app-config';

type S3BucketRow = Record<string, unknown>;

interface S3SyncTarget {
  account: AccountConfig;
  environment: PrivateEnvironmentConfig;
}

export async function listS3Buckets(opts?: { accountId?: string }): Promise<{ rows: S3BucketRow[]; error?: string }> {
  const target = resolveS3SyncTarget(opts?.accountId);
  if (!target) {
    return { rows: [], error: 'No AWS account is configured for S3 asset sync' };
  }

  const profile = target.account.profile || target.environment.awsProfile;
  if (!profile) {
    return { rows: [], error: `No AWS profile is configured for account ${target.account.accountId}` };
  }

  const region = target.account.region || 'ap-northeast-2';
  const endpoint = target.environment.endpointUrls?.s3;
  const client = new S3Client({
    region,
    endpoint,
    forcePathStyle: true,
    credentials: fromIni({ profile }),
  });

  try {
    const result = await client.send(new ListBucketsCommand({}));
    const rows = (result.Buckets || []).map((bucket) => {
      const name = bucket.Name || '';
      return {
        account_id: target.account.accountId,
        account_name: target.account.alias || '',
        region: 'global',
        name,
        id: name,
        arn: name ? `arn:aws:s3:::${name}` : '',
        status: 'available',
        tags: {},
        source_updated_at: bucket.CreationDate?.toISOString?.() || '',
      };
    });
    return { rows };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveS3SyncTarget(accountId?: string): S3SyncTarget | undefined {
  const config = getConfig();
  const active = config.activeEnvironment || 'dev';
  const environment = config.environments?.[active];
  if (!environment) return undefined;

  const accounts = config.accounts || [];
  const account = accountId
    ? accounts.find((candidate) => candidate.accountId === accountId)
    : accounts.find((candidate) => candidate.profile === environment.awsProfile)
      || accounts.find((candidate) => candidate.isHost)
      || accounts[0];

  if (!account) return undefined;
  return { account, environment };
}
