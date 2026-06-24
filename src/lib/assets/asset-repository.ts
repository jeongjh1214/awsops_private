import { randomUUID } from 'crypto';
import type { AssetDb } from './asset-db';
import type { AssetFieldType, AssetMetadata } from './asset-types';

export interface AssetListFilters {
  accountId?: string;
  region?: string;
  service?: string;
  resourceType?: string;
  phase?: string;
  ownerTeam?: string;
  active?: boolean;
  metadataMissing?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface AssetListResult {
  rows: AssetListRow[];
  total: number;
  limit: number;
  offset: number;
}

export type AssetListRow = AssetRecordSqlRow & AssetMetadataSqlFields;

export interface AssetDetail extends AssetRecordSqlRow {
  metadata: AssetMetadataSqlFields & {
    updated_by: string;
    metadata_updated_at: string;
  };
  customFields: AssetCustomFieldValueDetail[];
  events: AssetChangeEventSqlRow[];
}

export interface AssetMetadataUpdateInput {
  ownerTeam?: string;
  ownerPerson?: string;
  businessSystem?: string;
  moduleName?: string;
  phase?: string;
  purpose?: string;
  criticality?: string;
  securityGrade?: string;
  costCenter?: string;
  containsPersonalInfo?: boolean | null;
  remarks?: string;
  updatedBy?: string;
}

interface AssetRecordSqlRow {
  id: string;
  provider: string;
  account_id: string;
  account_name: string;
  region: string;
  service: string;
  resource_type: string;
  resource_id: string;
  resource_name: string;
  arn: string;
  status: string;
  native_state: string;
  tags_json: string;
  source_table: string;
  source_updated_at: string;
  first_discovered_at: string;
  last_seen_at: string;
  is_active: number;
  last_hash: string;
  created_at: string;
  updated_at: string;
}

interface AssetMetadataSqlFields {
  owner_team: string | null;
  owner_person: string | null;
  business_system: string | null;
  module_name: string | null;
  phase: string | null;
  purpose: string | null;
  criticality: string | null;
  security_grade: string | null;
  cost_center: string | null;
  contains_personal_info: number | null;
  remarks: string | null;
}

interface AssetMetadataSqlRow extends AssetMetadataSqlFields {
  asset_id: string;
  updated_by: string;
  updated_at: string;
}

interface AssetCustomFieldValueSqlRow {
  id: string;
  key: string;
  label: string;
  type: AssetFieldType;
  options_json: string;
  required: number;
  applies_to_services_json: string;
  applies_to_resource_types_json: string;
  display_order: number;
  active: number;
  value_json: string;
  updated_by: string;
  updated_at: string;
}

export interface AssetCustomFieldValueDetail {
  id: string;
  key: string;
  label: string;
  type: AssetFieldType;
  options: string[];
  required: boolean;
  appliesToServices: string[];
  appliesToResourceTypes: string[];
  displayOrder: number;
  active: boolean;
  value_json: string;
  updated_by: string;
  updated_at: string;
}

interface AssetChangeEventSqlRow {
  id: string;
  asset_id: string;
  event_type: string;
  event_source: string;
  summary: string;
  before_json: string;
  after_json: string;
  created_by: string;
  created_at: string;
}

const METADATA_SELECT = `
  m.owner_team,
  m.owner_person,
  m.business_system,
  m.module_name,
  m.phase,
  m.purpose,
  m.criticality,
  m.security_grade,
  m.cost_center,
  m.contains_personal_info,
  m.remarks
`;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function listAssets(db: AssetDb, filters: AssetListFilters = {}): AssetListResult {
  const limit = normalizeLimit(filters.limit);
  const offset = normalizeOffset(filters.offset);
  const query = makeListWhereClause(filters);

  const rows = db.prepare(`
    select r.*, ${METADATA_SELECT}
    from asset_records r
    left join asset_metadata m on m.asset_id = r.id
    ${query.whereSql}
    order by r.is_active desc, r.last_seen_at desc
    limit @limit offset @offset
  `).all({ ...query.params, limit, offset }) as AssetListRow[];

  const totalRow = db.prepare(`
    select count(*) as total
    from asset_records r
    left join asset_metadata m on m.asset_id = r.id
    ${query.whereSql}
  `).get(query.params) as { total: number };

  return {
    rows,
    total: totalRow.total,
    limit,
    offset,
  };
}

export function getAssetDetail(db: AssetDb, assetId: string): AssetDetail | null {
  const row = db.prepare(`
    select r.*, ${METADATA_SELECT},
      m.updated_by as metadata_updated_by,
      m.updated_at as metadata_updated_at
    from asset_records r
    left join asset_metadata m on m.asset_id = r.id
    where r.id = @assetId
  `).get({ assetId }) as (AssetRecordSqlRow & AssetMetadataSqlFields & {
    metadata_updated_by: string | null;
    metadata_updated_at: string | null;
  }) | undefined;

  if (!row) return null;

  const metadata = {
    owner_team: row.owner_team ?? '',
    owner_person: row.owner_person ?? '',
    business_system: row.business_system ?? '',
    module_name: row.module_name ?? '',
    phase: row.phase ?? 'unknown',
    purpose: row.purpose ?? '',
    criticality: row.criticality ?? '',
    security_grade: row.security_grade ?? '',
    cost_center: row.cost_center ?? '',
    contains_personal_info: row.contains_personal_info,
    remarks: row.remarks ?? '',
    updated_by: row.metadata_updated_by ?? '',
    metadata_updated_at: row.metadata_updated_at ?? '',
  };

  return {
    ...row,
    metadata,
    customFields: getAssetCustomFields(db, assetId),
    events: getRecentAssetEvents(db, assetId),
  };
}

export function updateAssetMetadata(
  db: AssetDb,
  assetId: string,
  input: AssetMetadataUpdateInput,
  now: string = new Date().toISOString(),
): boolean {
  const asset = db.prepare('select id, resource_type, resource_name from asset_records where id = @assetId')
    .get({ assetId }) as { id: string; resource_type: string; resource_name: string } | undefined;
  if (!asset) return false;

  const existing = getStoredMetadata(db, assetId);
  const before = existing ? sqlMetadataToSnapshot(existing) : defaultMetadataSnapshot(assetId);
  const after = applyMetadataInput(before, input, now);

  db.transaction(() => {
    db.prepare(`
      insert into asset_metadata (
        asset_id,
        owner_team,
        owner_person,
        business_system,
        module_name,
        phase,
        purpose,
        criticality,
        security_grade,
        cost_center,
        contains_personal_info,
        remarks,
        updated_by,
        updated_at
      ) values (
        @assetId,
        @ownerTeam,
        @ownerPerson,
        @businessSystem,
        @moduleName,
        @phase,
        @purpose,
        @criticality,
        @securityGrade,
        @costCenter,
        @containsPersonalInfoSql,
        @remarks,
        @updatedBy,
        @updatedAt
      )
      on conflict(asset_id) do update set
        owner_team = excluded.owner_team,
        owner_person = excluded.owner_person,
        business_system = excluded.business_system,
        module_name = excluded.module_name,
        phase = excluded.phase,
        purpose = excluded.purpose,
        criticality = excluded.criticality,
        security_grade = excluded.security_grade,
        cost_center = excluded.cost_center,
        contains_personal_info = excluded.contains_personal_info,
        remarks = excluded.remarks,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).run(snapshotToSqlParams(after));

    db.prepare(`
      insert into asset_change_events (
        id,
        asset_id,
        event_type,
        event_source,
        summary,
        before_json,
        after_json,
        created_by,
        created_at
      ) values (
        @id,
        @assetId,
        'metadata_updated',
        'user',
        @summary,
        @beforeJson,
        @afterJson,
        @createdBy,
        @createdAt
      )
    `).run({
      id: randomUUID(),
      assetId,
      summary: `Updated metadata for ${asset.resource_type} ${asset.resource_name}`,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(after),
      createdBy: after.updatedBy,
      createdAt: now,
    });
  })();

  return true;
}

function makeListWhereClause(filters: AssetListFilters): {
  whereSql: string;
  params: Record<string, unknown>;
} {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  addTextFilter(conditions, params, 'r.account_id', 'accountId', filters.accountId);
  addTextFilter(conditions, params, 'r.region', 'region', filters.region);
  addTextFilter(conditions, params, 'r.service', 'service', filters.service);
  addTextFilter(conditions, params, 'r.resource_type', 'resourceType', filters.resourceType);
  addTextFilter(conditions, params, 'm.phase', 'phase', filters.phase);
  addTextFilter(conditions, params, 'm.owner_team', 'ownerTeam', filters.ownerTeam);

  if (filters.active !== undefined) {
    conditions.push('r.is_active = @active');
    params.active = filters.active ? 1 : 0;
  }

  if (filters.metadataMissing !== undefined) {
    conditions.push(filters.metadataMissing ? 'm.asset_id is null' : 'm.asset_id is not null');
  }

  const q = filters.q?.trim();
  if (q) {
    conditions.push(`(
      r.id like @q
      or r.account_name like @q
      or r.resource_id like @q
      or r.resource_name like @q
      or r.arn like @q
      or m.owner_team like @q
      or m.owner_person like @q
      or m.business_system like @q
      or m.module_name like @q
      or m.purpose like @q
      or m.remarks like @q
    )`);
    params.q = `%${q}%`;
  }

  return {
    whereSql: conditions.length ? `where ${conditions.join(' and ')}` : '',
    params,
  };
}

function addTextFilter(
  conditions: string[],
  params: Record<string, unknown>,
  column: string,
  paramName: string,
  value?: string,
): void {
  if (value === undefined || value === '') return;
  conditions.push(`${column} = @${paramName}`);
  params[paramName] = value;
}

function normalizeLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(value as number)));
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value as number));
}

function getStoredMetadata(db: AssetDb, assetId: string): AssetMetadataSqlRow | undefined {
  return db.prepare('select * from asset_metadata where asset_id = @assetId')
    .get({ assetId }) as AssetMetadataSqlRow | undefined;
}

function defaultMetadataSnapshot(assetId: string): AssetMetadata {
  return {
    assetId,
    ownerTeam: '',
    ownerPerson: '',
    businessSystem: '',
    moduleName: '',
    phase: 'unknown',
    purpose: '',
    criticality: '',
    securityGrade: '',
    costCenter: '',
    containsPersonalInfo: null,
    remarks: '',
    updatedBy: '',
    updatedAt: '',
  };
}

function sqlMetadataToSnapshot(row: AssetMetadataSqlRow): AssetMetadata {
  return {
    assetId: row.asset_id,
    ownerTeam: row.owner_team ?? '',
    ownerPerson: row.owner_person ?? '',
    businessSystem: row.business_system ?? '',
    moduleName: row.module_name ?? '',
    phase: row.phase ?? 'unknown',
    purpose: row.purpose ?? '',
    criticality: row.criticality ?? '',
    securityGrade: row.security_grade ?? '',
    costCenter: row.cost_center ?? '',
    containsPersonalInfo: row.contains_personal_info === null ? null : row.contains_personal_info === 1,
    remarks: row.remarks ?? '',
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function applyMetadataInput(
  before: AssetMetadata,
  input: AssetMetadataUpdateInput,
  now: string,
): AssetMetadata {
  const after = { ...before, updatedAt: now };

  applyStringField(after, input, 'ownerTeam');
  applyStringField(after, input, 'ownerPerson');
  applyStringField(after, input, 'businessSystem');
  applyStringField(after, input, 'moduleName');
  applyStringField(after, input, 'phase');
  applyStringField(after, input, 'purpose');
  applyStringField(after, input, 'criticality');
  applyStringField(after, input, 'securityGrade');
  applyStringField(after, input, 'costCenter');
  applyStringField(after, input, 'remarks');
  applyStringField(after, input, 'updatedBy');

  if (Object.prototype.hasOwnProperty.call(input, 'containsPersonalInfo')) {
    after.containsPersonalInfo = input.containsPersonalInfo ?? null;
  }

  return after;
}

function applyStringField<K extends keyof AssetMetadataUpdateInput & keyof AssetMetadata>(
  target: AssetMetadata,
  input: AssetMetadataUpdateInput,
  key: K,
): void {
  if (input[key] !== undefined) {
    target[key] = input[key] as AssetMetadata[K];
  }
}

function snapshotToSqlParams(snapshot: AssetMetadata): Record<string, unknown> {
  return {
    assetId: snapshot.assetId,
    ownerTeam: snapshot.ownerTeam,
    ownerPerson: snapshot.ownerPerson,
    businessSystem: snapshot.businessSystem,
    moduleName: snapshot.moduleName,
    phase: snapshot.phase,
    purpose: snapshot.purpose,
    criticality: snapshot.criticality,
    securityGrade: snapshot.securityGrade,
    costCenter: snapshot.costCenter,
    containsPersonalInfoSql: snapshot.containsPersonalInfo === null ? null : snapshot.containsPersonalInfo ? 1 : 0,
    remarks: snapshot.remarks,
    updatedBy: snapshot.updatedBy,
    updatedAt: snapshot.updatedAt,
  };
}

function getAssetCustomFields(db: AssetDb, assetId: string): AssetCustomFieldValueDetail[] {
  const rows = db.prepare(`
    select
      d.id,
      d.key,
      d.label,
      d.type,
      d.options_json,
      d.required,
      d.applies_to_services_json,
      d.applies_to_resource_types_json,
      d.display_order,
      d.active,
      v.value_json,
      v.updated_by,
      v.updated_at
    from asset_custom_field_values v
    join asset_custom_field_definitions d on d.id = v.field_id
    where v.asset_id = @assetId
    order by d.display_order asc, d.label asc
  `).all({ assetId }) as AssetCustomFieldValueSqlRow[];

  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    options: parseStringArray(row.options_json),
    required: row.required === 1,
    appliesToServices: parseStringArray(row.applies_to_services_json),
    appliesToResourceTypes: parseStringArray(row.applies_to_resource_types_json),
    displayOrder: row.display_order,
    active: row.active === 1,
    value_json: row.value_json,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  }));
}

function getRecentAssetEvents(db: AssetDb, assetId: string): AssetChangeEventSqlRow[] {
  return db.prepare(`
    select *
    from asset_change_events
    where asset_id = @assetId
    order by created_at desc, id desc
    limit 50
  `).all({ assetId }) as AssetChangeEventSqlRow[];
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}
