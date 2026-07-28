export const QUERY_SERVICES = [
  'ec2',
  'lambda',
  'ecs',
  'ecr',
  'eks',
  'vpc',
  'cloudfront',
  'waf',
  'ebs',
  's3',
  'rds',
  'dynamodb',
  'elasticache',
  'opensearch',
  'msk',
  'cloudwatch',
  'cloudtrail',
  'cost',
  'iam',
  'bedrock',
] as const;

export type QueryService = (typeof QUERY_SERVICES)[number];

export interface QueryPolicyConfig {
  enabledServices: QueryService[];
  allowComplianceBenchmark?: boolean;
}

export const DEFAULT_ENABLED_QUERY_SERVICES: QueryService[] = [
  'ec2',
  'lambda',
  'ecs',
  'vpc',
  'ebs',
  's3',
  'rds',
  'dynamodb',
  'elasticache',
  'cloudwatch',
  'iam',
];

const QUERY_SERVICE_SET = new Set<string>(QUERY_SERVICES);

export function normalizeEnabledQueryServices(value: unknown): QueryService[] {
  if (!Array.isArray(value)) return [...DEFAULT_ENABLED_QUERY_SERVICES];
  return Array.from(new Set(
    value.filter((service): service is QueryService => (
      typeof service === 'string' && QUERY_SERVICE_SET.has(service)
    )),
  ));
}

function serviceForAwsTable(table: string): QueryService | string {
  if (/^aws_ec2_(application|network)_load_balancer/.test(table)) return 'vpc';
  if (/^aws_ec2_transit_gateway/.test(table)) return 'vpc';
  if (/^aws_vpc(?:_|$)/.test(table)) return 'vpc';
  if (/^aws_ec2_/.test(table)) return 'ec2';
  if (/^aws_lambda_/.test(table)) return 'lambda';
  if (/^aws_ecs_/.test(table)) return 'ecs';
  if (/^aws_ecr_/.test(table)) return 'ecr';
  if (/^aws_eks_/.test(table)) return 'eks';
  if (/^aws_cloudfront_/.test(table)) return 'cloudfront';
  if (/^aws_wafv2_/.test(table)) return 'waf';
  if (/^aws_ebs_/.test(table)) return 'ebs';
  if (/^aws_s3_/.test(table)) return 's3';
  if (/^aws_rds_/.test(table)) return 'rds';
  if (/^aws_dynamodb_/.test(table)) return 'dynamodb';
  if (/^aws_elasticache_/.test(table)) return 'elasticache';
  if (/^aws_opensearch_/.test(table)) return 'opensearch';
  if (/^aws_msk_/.test(table)) return 'msk';
  if (/^aws_cloudwatch_/.test(table)) return 'cloudwatch';
  if (/^aws_cloudtrail_/.test(table)) return 'cloudtrail';
  if (/^aws_cost_/.test(table)) return 'cost';
  if (/^aws_(iam|identitystore|ssoadmin|sts)_/.test(table)) return 'iam';
  if (/^aws_(caller_identity|account|partition)$/.test(table)) return 'iam';
  if (/^aws_bedrock_/.test(table)) return 'bedrock';

  return `unknown:${table}`;
}

export function detectQueryServices(sql: string): string[] {
  const tables = sql.toLowerCase().match(/\baws_[a-z0-9_]+\b/g) || [];
  return Array.from(new Set(tables.map(serviceForAwsTable)));
}

export function getBlockedQueryServices(sql: string, enabledServices: Iterable<string>): string[] {
  const enabled = new Set(enabledServices);
  return detectQueryServices(sql).filter((service) => !enabled.has(service));
}

export function filterQueryRecordByPolicy(
  queries: Record<string, string>,
  enabledServices: Iterable<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(queries).filter(([, sql]) => getBlockedQueryServices(sql, enabledServices).length === 0),
  );
}
