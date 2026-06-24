import type { AssetDb } from './asset-db';
import { listAssets, type AssetListFilters, type AssetListRow } from './asset-repository';

export interface AssetInventoryContextOptions {
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

const QUESTION_KEYWORDS = [
  '자산관리',
  '클라우드 자산',
  '담당조직',
  '담당 조직',
  '담당 팀',
  'owner team',
  'module',
  'metadata',
  '관리대장',
  '개인정보',
  'asset inventory',
  'asset register',
  'asset ledger',
];

export function detectAssetInventoryQuestion(question: string): boolean {
  const normalized = normalize(question);
  return QUESTION_KEYWORDS.some((keyword) => normalized.includes(normalize(keyword)));
}

export function buildAssetInventoryContext(
  db: AssetDb,
  question: string,
  opts: AssetInventoryContextOptions = {},
): AssetInventoryContext {
  const limit = normalizeLimit(opts.limit);
  const filters = inferAssetInventoryFilters(question);
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
