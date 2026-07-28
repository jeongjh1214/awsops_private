import type { AssetDb } from './asset-db';
import { listAssets, type AssetListFilters, type AssetListRow } from './asset-repository';
import { listS3GovernanceRecords, type S3GovernanceFilters, type S3GovernanceRow } from './s3-governance';

export interface AssetInventoryContextOptions {
  accountId?: string;
  limit?: number;
}

export interface AssetInventoryContextRow {
  id: string;
  account_id: string;
  account_name: string;
  region: string;
  service: string;
  resource_type: string;
  resource_id: string;
  resource_name: string;
  status: string;
  native_state: string;
  is_active: boolean;
  owner_team: string;
  owner_person: string;
  business_system: string;
  module_name: string;
  phase: string;
  purpose: string;
  criticality: string;
  security_grade: string;
  cost_center: string;
  contains_personal_info: boolean | null;
  metadata_missing: boolean;
}

export interface AssetInventoryContext {
  question: string;
  filters: AssetListFilters;
  rows: AssetInventoryContextRow[];
  total: number;
  limit: number;
  summary: {
    serviceCounts: Record<string, number>;
    metadataMissingCount: number;
  };
}

export interface S3GovernanceContextRow {
  stable_key: string;
  account_id: string;
  account_name: string;
  phase: string;
  bucket_name: string;
  owner_team: string;
  purpose: string;
  history: string;
  contains_personal_info: boolean | null;
  pii_retention_aware: boolean | null;
  pii_retention_applied: boolean | null;
  pii_retention_period: string;
  remarks: string;
  asset_is_active: boolean | null;
  asset_last_seen_at: string;
}

export interface S3GovernanceContext {
  question: string;
  filters: S3GovernanceFilters;
  rows: S3GovernanceContextRow[];
  total: number;
  limit: number;
  summary: {
    activeCount: number;
    missingOrUnlinkedCount: number;
    personalInfoCount: number;
    retentionNotAppliedCount: number;
  };
}

const LEDGER_ANCHOR_KEYWORDS = [
  '자산관리',
  '클라우드 자산',
  '관리대장',
  'asset inventory',
  'asset register',
  'asset ledger',
  'cloud asset',
  'cloud assets',
];

const LEDGER_DETAIL_KEYWORDS = [
  '담당조직',
  '담당 조직',
  '담당 팀',
  'owner team',
  'module',
  'metadata',
  '개인정보',
  'phase',
  'purpose',
];

const S3_GOVERNANCE_KEYWORDS = [
  's3 관리대장',
  's3 자산관리',
  'bucket register',
  'bucket governance',
  '버킷 관리대장',
  '개인정보 데이터 유효기간',
  '개인정보 유효기간',
  '유효기간 적용',
  'pii retention',
  'retention applied',
];

export function detectAssetInventoryQuestion(question: string): boolean {
  const normalized = normalize(question);
  if (detectS3GovernanceQuestion(question)) return true;
  if (LEDGER_ANCHOR_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword)))) return true;

  const hasLedgerContext = normalized.includes('자산') || /\bassets?\b/.test(normalized);
  if (!hasLedgerContext) return false;
  return LEDGER_DETAIL_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword)));
}

export function detectS3GovernanceQuestion(question: string): boolean {
  const normalized = normalize(question);
  const mentionsS3 = /\b(s3|bucket|buckets)\b/.test(normalized) || normalized.includes('버킷');
  const mentionsGovernance = S3_GOVERNANCE_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword)));
  if (mentionsS3 && mentionsGovernance) return true;

  if (!mentionsS3) return false;
  return (
    normalized.includes('담당조직')
    || normalized.includes('용도')
    || normalized.includes('비고')
    || normalized.includes('이력')
    || normalized.includes('개인정보')
    || normalized.includes('유효기간')
    || normalized.includes('retention')
    || normalized.includes('owner team')
  );
}

export function detectLiveS3InventoryQuestion(question: string): boolean {
  if (detectS3GovernanceQuestion(question)) return false;

  const normalized = normalize(question);
  const mentionsS3 = /\b(s3|bucket|buckets)\b/.test(normalized) || normalized.includes('버킷');
  if (!mentionsS3) return false;

  const documentationIntent = [
    '모범 사례',
    'best practice',
    '사용법',
    '사용 방법',
    '설정 방법',
    '생성 방법',
    '만드는 법',
    '개념',
    '어떤 서비스',
    '무슨 서비스',
    '차이',
    '요금',
    '가격',
    'naming convention',
    '이름 규칙',
    '정책 예시',
    '코드 예제',
  ].some((keyword) => normalized.includes(keyword));
  if (documentationIntent) return false;

  const inventoryIntent = [
    '목록',
    '리스트',
    '현황',
    '몇개',
    '몇 개',
    '상태',
    '보여',
    '조회',
    '가져',
    '현재',
    '실제',
    'list',
    'count',
    'status',
    'show',
    'inventory',
    '어떤',
    '정보',
    '암호화',
    '버전관리',
    '버전 관리',
    '퍼블릭',
    'public',
    'private',
    '리전',
    'region',
    '생성일',
    '정책',
    'policy',
    '로깅',
    'logging',
    'lifecycle',
    '수명 주기',
  ].some((keyword) => normalized.includes(keyword));

  // A bucket-specific question is normally asking about this account's live
  // inventory. Plain "S3란?" questions remain documentation/general queries.
  return inventoryIntent || normalized.includes('버킷') || /\bbuckets?\b/.test(normalized);
}

export function detectS3GovernanceConversation(messages: Array<{ role: string; content: string }>): boolean {
  const recentUserMessages = messages
    .filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.content);
  return recentUserMessages.some(detectS3GovernanceQuestion);
}

export function buildAssetInventoryContext(
  db: AssetDb,
  question: string,
  opts: AssetInventoryContextOptions = {},
): AssetInventoryContext {
  const limit = normalizeLimit(opts.limit);
  const filters = inferAssetInventoryFilters(question);
  if (opts.accountId) filters.accountId = opts.accountId;
  const result = listAssets(db, { ...filters, limit, offset: 0 });
  const rows = result.rows.map(toContextRow);

  return {
    question,
    filters,
    rows,
    total: result.total,
    limit: result.limit,
    summary: summarizeRows(rows),
  };
}

export function formatAssetInventoryContext(context: AssetInventoryContext): string {
  const payload = {
    source: 'stored_cloud_asset_inventory_db',
    note: 'This is a saved asset ledger snapshot, not a live AWS API query.',
    filters: context.filters,
    total: context.total,
    returned_rows: context.rows.length,
    summary: context.summary,
    rows: context.rows,
  };

  return [
    `--- STORED CLOUD ASSET INVENTORY CONTEXT (${context.rows.length}/${context.total} rows) ---`,
    'Use only this saved asset ledger context for asset inventory answers.',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

export function buildS3GovernanceContext(
  db: AssetDb,
  question: string,
  opts: AssetInventoryContextOptions = {},
): S3GovernanceContext {
  const limit = normalizeLimit(opts.limit);
  const filters = inferS3GovernanceFilters(question);
  if (opts.accountId) filters.accountId = opts.accountId;
  const result = listS3GovernanceRecords(db, { ...filters, limit, offset: 0 });
  const rows = result.rows.map(toS3GovernanceContextRow);

  return {
    question,
    filters,
    rows,
    total: result.total,
    limit: result.limit,
    summary: summarizeS3GovernanceRows(rows),
  };
}

export function formatS3GovernanceContext(context: S3GovernanceContext): string {
  const payload = {
    source: 'stored_s3_governance_register_db',
    note: 'This is a saved S3 governance register, not a live AWS API query.',
    filters: context.filters,
    total: context.total,
    returned_rows: context.rows.length,
    summary: context.summary,
    rows: context.rows,
  };

  return [
    `--- STORED S3 GOVERNANCE REGISTER CONTEXT (${context.rows.length}/${context.total} rows) ---`,
    'Use only this saved S3 governance register context for S3 governance answers.',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
  ].join('\n');
}

function inferAssetInventoryFilters(question: string): AssetListFilters {
  const normalized = normalize(question);
  const filters: AssetListFilters = {};

  if (/\b(s3|bucket|buckets)\b/.test(normalized) || normalized.includes('버킷')) {
    filters.service = 's3';
  } else if (/\b(ec2|instance|instances)\b/.test(normalized) || normalized.includes('인스턴스')) {
    filters.service = 'ec2';
  }

  if (
    /\b(missing|unset|unfilled|incomplete|blank|empty)\b/.test(normalized)
    || normalized.includes('누락')
    || normalized.includes('미입력')
    || normalized.includes('비어')
  ) {
    filters.metadataMissing = true;
  }

  const phase = inferPhase(normalized);
  if (phase) filters.phase = phase;

  return filters;
}

function inferS3GovernanceFilters(question: string): S3GovernanceFilters {
  const normalized = normalize(question);
  const filters: S3GovernanceFilters = {};

  const phase = inferPhase(normalized);
  if (phase) filters.phase = phase;

  if (
    normalized.includes('삭제')
    || normalized.includes('누락')
    || normalized.includes('missing')
    || normalized.includes('deleted')
  ) {
    filters.active = false;
  }

  if (
    normalized.includes('개인정보 있음')
    || normalized.includes('개인정보 포함')
    || /\bpii\b/.test(normalized)
    || normalized.includes('personal info')
  ) {
    filters.containsPersonalInfo = true;
  }

  if (
    normalized.includes('유효기간 인지 안')
    || normalized.includes('retention unaware')
  ) {
    filters.piiRetentionAware = false;
  }

  if (
    normalized.includes('유효기간 적용 안')
    || normalized.includes('적용 안')
    || normalized.includes('미적용')
    || normalized.includes('not applied')
    || normalized.includes('unapplied')
  ) {
    filters.piiRetentionApplied = false;
  }

  return filters;
}

function inferPhase(normalizedQuestion: string): string | undefined {
  if (/\b(prod|production)\b/.test(normalizedQuestion) || normalizedQuestion.includes('운영')) return 'prod';
  if (/\b(dev|development)\b/.test(normalizedQuestion) || normalizedQuestion.includes('개발')) return 'dev';
  if (/\b(stage|staging|stg)\b/.test(normalizedQuestion) || normalizedQuestion.includes('스테이징')) return 'stage';
  if (/\b(test|testing)\b/.test(normalizedQuestion) || normalizedQuestion.includes('테스트')) return 'test';
  return undefined;
}

function toContextRow(row: AssetListRow): AssetInventoryContextRow {
  return {
    id: row.id,
    account_id: row.account_id,
    account_name: row.account_name,
    region: row.region,
    service: row.service,
    resource_type: row.resource_type,
    resource_id: truncate(row.resource_id, 120),
    resource_name: truncate(row.resource_name, 120),
    status: row.status,
    native_state: row.native_state,
    is_active: row.is_active === 1,
    owner_team: row.owner_team ?? '',
    owner_person: row.owner_person ?? '',
    business_system: row.business_system ?? '',
    module_name: row.module_name ?? '',
    phase: row.phase ?? 'unknown',
    purpose: truncate(row.purpose ?? '', 180),
    criticality: row.criticality ?? '',
    security_grade: row.security_grade ?? '',
    cost_center: row.cost_center ?? '',
    contains_personal_info: toNullableBoolean(row.contains_personal_info),
    metadata_missing: isMetadataMissing(row),
  };
}

function summarizeRows(rows: AssetInventoryContextRow[]): AssetInventoryContext['summary'] {
  const serviceCounts: Record<string, number> = {};
  let metadataMissingCount = 0;

  for (const row of rows) {
    serviceCounts[row.service] = (serviceCounts[row.service] || 0) + 1;
    if (row.metadata_missing) metadataMissingCount += 1;
  }

  return { serviceCounts, metadataMissingCount };
}

function toS3GovernanceContextRow(row: S3GovernanceRow): S3GovernanceContextRow {
  return {
    stable_key: row.stable_key,
    account_id: row.account_id,
    account_name: row.account_name,
    phase: row.phase,
    bucket_name: row.bucket_name,
    owner_team: row.owner_team,
    purpose: truncate(row.purpose, 180),
    history: truncate(row.history, 240),
    contains_personal_info: toNullableBoolean(row.contains_personal_info),
    pii_retention_aware: toNullableBoolean(row.pii_retention_aware),
    pii_retention_applied: toNullableBoolean(row.pii_retention_applied),
    pii_retention_period: row.pii_retention_period,
    remarks: truncate(row.remarks, 180),
    asset_is_active: row.asset_is_active === null ? null : row.asset_is_active === 1,
    asset_last_seen_at: row.asset_last_seen_at ?? '',
  };
}

function summarizeS3GovernanceRows(rows: S3GovernanceContextRow[]): S3GovernanceContext['summary'] {
  let activeCount = 0;
  let missingOrUnlinkedCount = 0;
  let personalInfoCount = 0;
  let retentionNotAppliedCount = 0;

  for (const row of rows) {
    if (row.asset_is_active === true) activeCount += 1;
    if (row.asset_is_active !== true) missingOrUnlinkedCount += 1;
    if (row.contains_personal_info === true) personalInfoCount += 1;
    if (row.pii_retention_applied === false) retentionNotAppliedCount += 1;
  }

  return {
    activeCount,
    missingOrUnlinkedCount,
    personalInfoCount,
    retentionNotAppliedCount,
  };
}

function isMetadataMissing(row: AssetListRow): boolean {
  return (
    !row.owner_team
    || !row.module_name
    || !row.phase
    || row.phase === 'unknown'
  );
}

function toNullableBoolean(value: number | null): boolean | null {
  if (value === null) return null;
  return value === 1;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 120;
  return Math.min(200, Math.max(1, Math.trunc(value as number)));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
