import {
  GetBucketEncryptionCommand,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
    const rows = await mapWithConcurrency(result.Buckets || [], 5, async (bucket) => {
      const name = bucket.Name || '';
      const details = name
        ? await getBucketDetails(client, name, region)
        : { region, versioningEnabled: null, encryptionConfiguration: null, loggingTarget: '' };
      return {
        account_id: target.account.accountId,
        account_name: target.account.alias || '',
        region: details.region,
        name,
        id: name,
        arn: name ? `arn:aws:s3:::${name}` : '',
        status: 'available',
        versioning_enabled: details.versioningEnabled,
        server_side_encryption_configuration: details.encryptionConfiguration,
        encryption_enabled: details.encryptionConfiguration !== null
          ? Boolean(details.encryptionConfiguration)
          : null,
        logging_target: details.loggingTarget,
        tags: {},
        source_updated_at: bucket.CreationDate?.toISOString?.() || '',
      };
    });
    return { rows };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function getBucketDetails(
  client: S3Client,
  bucketName: string,
  fallbackRegion: string,
): Promise<{
  region: string;
  versioningEnabled: boolean | null;
  encryptionConfiguration: unknown | null;
  loggingTarget: string;
}> {
  const [location, versioning, encryption, logging] = await Promise.all([
    safeSend<{ LocationConstraint?: unknown }>(client, new GetBucketLocationCommand({ Bucket: bucketName })),
    safeSend<{ Status?: string }>(client, new GetBucketVersioningCommand({ Bucket: bucketName })),
    safeSend<{ ServerSideEncryptionConfiguration?: unknown }>(client, new GetBucketEncryptionCommand({ Bucket: bucketName })),
    safeSend<{ LoggingEnabled?: { TargetBucket?: string } }>(client, new GetBucketLoggingCommand({ Bucket: bucketName })),
  ]);

  return {
    region: location ? normalizeBucketRegion(location.LocationConstraint) : fallbackRegion,
    versioningEnabled: versioning ? versioning.Status === 'Enabled' : null,
    encryptionConfiguration: encryption
      ? (encryption.ServerSideEncryptionConfiguration || null)
      : null,
    loggingTarget: logging?.LoggingEnabled?.TargetBucket || '',
  };
}

async function safeSend<T>(client: S3Client, command: { input: unknown }): Promise<T | null> {
  try {
    return await client.send(command as never) as T;
  } catch {
    return null;
  }
}

function normalizeBucketRegion(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return 'us-east-1';
  if (value === 'EU') return 'eu-west-1';
  return value;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
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
