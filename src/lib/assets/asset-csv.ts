import type { AssetDb } from './asset-db';
import {
  listAssets,
  updateAssetMetadata,
  type AssetListFilters,
  type AssetListRow,
  type AssetMetadataUpdateInput,
} from './asset-repository';

export const ASSET_CSV_HEADERS = [
  'asset_id',
  'account_name',
  'account_id',
  'phase',
  'service',
  'resource_type',
  'resource_name',
  'owner_team',
  'owner_person',
  'business_system',
  'module_name',
  'purpose',
  'criticality',
  'security_grade',
  'cost_center',
  'contains_personal_info',
  'remarks',
] as const;

export interface AssetCsvImportError {
  rowNumber: number;
  message: string;
}

export interface AssetCsvPreviewRow {
  rowNumber: number;
  assetId: string | null;
  values: AssetMetadataUpdateInput;
  errors: AssetCsvImportError[];
}

export interface AssetCsvImportPreview {
  rows: AssetCsvPreviewRow[];
  valid: number;
  invalid: number;
  errors: AssetCsvImportError[];
}

export interface AssetCsvImportApplyResult extends AssetCsvImportPreview {
  applied: number;
}

type CsvHeader = typeof ASSET_CSV_HEADERS[number] | 'region';

const METADATA_FIELDS: Record<string, keyof AssetMetadataUpdateInput> = {
  owner_team: 'ownerTeam',
  owner_person: 'ownerPerson',
  business_system: 'businessSystem',
  module_name: 'moduleName',
  phase: 'phase',
  purpose: 'purpose',
  criticality: 'criticality',
  security_grade: 'securityGrade',
  cost_center: 'costCenter',
  contains_personal_info: 'containsPersonalInfo',
  remarks: 'remarks',
};

const HEADER_ALIASES = new Map<string, CsvHeader>([
  ...ASSET_CSV_HEADERS.map((header) => [normalizeHeader(header), header] as [string, CsvHeader]),
  [normalizeHeader('region'), 'region'],
  [normalizeHeader('account name'), 'account_name'],
  [normalizeHeader('accountid'), 'account_id'],
  [normalizeHeader('account id'), 'account_id'],
  [normalizeHeader('resource type'), 'resource_type'],
  [normalizeHeader('bucketname'), 'resource_name'],
  [normalizeHeader('bucket name'), 'resource_name'],
  [normalizeHeader('담당조직'), 'owner_team'],
  [normalizeHeader('용도'), 'purpose'],
  [normalizeHeader('비고'), 'remarks'],
  [normalizeHeader('개인정보 데이터 유무 여부'), 'contains_personal_info'],
]);

export function exportAssetsCsv(db: AssetDb, filters: AssetListFilters = {}): string {
  const rows: AssetListRow[] = [];
  const exportFilters: AssetListFilters = { ...filters };
  delete exportFilters.limit;
  delete exportFilters.offset;

  const pageSize = 500;
  let offset = 0;

  for (;;) {
    const page = listAssets(db, { ...exportFilters, limit: pageSize, offset });
    rows.push(...page.rows);
    if (page.rows.length < page.limit) break;
    offset += page.limit;
  }

  return serializeCsv([
    [...ASSET_CSV_HEADERS],
    ...rows.map(assetToCsvRow),
  ]);
}

export function previewAssetCsvImport(db: AssetDb, csvText: string): AssetCsvImportPreview {
  let parsedRows: string[][];
  try {
    parsedRows = parseCsv(csvText);
  } catch (error) {
    return {
      rows: [],
      valid: 0,
      invalid: 0,
      errors: [{
        rowNumber: 1,
        message: error instanceof Error ? error.message : 'Invalid CSV',
      }],
    };
  }

  const errors: AssetCsvImportError[] = [];
  const previewRows: AssetCsvPreviewRow[] = [];

  if (parsedRows.length === 0 || parsedRows[0].every((value) => value.trim() === '')) {
    const error = { rowNumber: 1, message: 'CSV header row is required' };
    return { rows: [], valid: 0, invalid: 0, errors: [error] };
  }

  const headers = parsedRows[0].map((header) => HEADER_ALIASES.get(normalizeHeader(header)) ?? null);
  if (!headers.some(Boolean)) {
    const error = { rowNumber: 1, message: 'CSV does not contain supported asset columns' };
    return { rows: [], valid: 0, invalid: 0, errors: [error] };
  }

  for (let index = 1; index < parsedRows.length; index += 1) {
    const rawRow = parsedRows[index];
    if (rawRow.every((value) => value.trim() === '')) continue;

    const rowNumber = index + 1;
    const rowValues = makeCanonicalRow(headers, rawRow);
    const rowErrors: AssetCsvImportError[] = [];
    const assetId = resolveImportAssetId(db, rowValues, rowNumber, rowErrors);
    const values = makeMetadataUpdate(rowValues, rowNumber, rowErrors);

    if (Object.keys(values).length === 0) {
      rowErrors.push({ rowNumber, message: 'No metadata fields to update' });
    }

    previewRows.push({
      rowNumber,
      assetId,
      values,
      errors: rowErrors,
    });
    errors.push(...rowErrors);
  }

  const invalid = previewRows.filter((row) => row.errors.length > 0).length;
  return {
    rows: previewRows,
    valid: previewRows.length - invalid,
    invalid,
    errors,
  };
}

export function applyAssetCsvImport(
  db: AssetDb,
  csvText: string,
  updatedBy = 'csv-import',
): AssetCsvImportApplyResult {
  const preview = previewAssetCsvImport(db, csvText);
  if (preview.invalid > 0 || preview.errors.length > 0) {
    return { ...preview, applied: 0 };
  }

  const validRows = preview.rows.filter((row): row is AssetCsvPreviewRow & { assetId: string } => (
    row.assetId !== null && row.errors.length === 0
  ));

  db.transaction(() => {
    for (const row of validRows) {
      updateAssetMetadata(db, row.assetId, {
        ...row.values,
        updatedBy,
      });
    }
  })();

  return { ...preview, applied: validRows.length };
}

function assetToCsvRow(row: AssetListRow): string[] {
  return [
    row.id,
    row.account_name,
    row.account_id,
    row.phase ?? '',
    row.service,
    row.resource_type,
    row.resource_name,
    row.owner_team ?? '',
    row.owner_person ?? '',
    row.business_system ?? '',
    row.module_name ?? '',
    row.purpose ?? '',
    row.criticality ?? '',
    row.security_grade ?? '',
    row.cost_center ?? '',
    formatNullableBoolean(row.contains_personal_info),
    row.remarks ?? '',
  ];
}

function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\n');
}

function escapeCsvValue(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];

    if (inQuotes) {
      if (char === '"') {
        if (csvText[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n' || char === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (char === '\r' && csvText[index + 1] === '\n') index += 1;
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error('Unclosed quoted CSV field');
  }

  if (field !== '' || row.length > 0 || csvText.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function makeCanonicalRow(
  headers: Array<CsvHeader | null>,
  rawRow: string[],
): Partial<Record<CsvHeader, string>> {
  const rowValues: Partial<Record<CsvHeader, string>> = {};
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    if (!header) continue;
    rowValues[header] = rawRow[index] ?? '';
  }
  return rowValues;
}

function resolveImportAssetId(
  db: AssetDb,
  rowValues: Partial<Record<CsvHeader, string>>,
  rowNumber: number,
  errors: AssetCsvImportError[],
): string | null {
  const explicitAssetId = cleanMatchValue(rowValues.asset_id);
  if (explicitAssetId) {
    const found = db.prepare('select id from asset_records where id = @assetId')
      .get({ assetId: explicitAssetId }) as { id: string } | undefined;
    if (found) return found.id;
    errors.push({ rowNumber, message: `Asset not found: ${explicitAssetId}` });
    return null;
  }

  const accountId = cleanMatchValue(rowValues.account_id);
  const service = cleanMatchValue(rowValues.service);
  const resourceType = cleanMatchValue(rowValues.resource_type);
  const resourceName = cleanMatchValue(rowValues.resource_name);
  const region = cleanMatchValue(rowValues.region);
  if (!accountId || !service || !resourceType || !resourceName) {
    errors.push({
      rowNumber,
      message: 'asset_id or account_id, service, resource_type, resource_name are required',
    });
    return null;
  }

  const params: Record<string, string> = { accountId, service, resourceType, resourceName };
  const regionClause = region ? 'and region = @region' : '';
  if (region) params.region = region;
  const matches = db.prepare(`
    select id
    from asset_records
    where account_id = @accountId
      and service = @service
      and resource_type = @resourceType
      and resource_name = @resourceName
      ${regionClause}
    order by is_active desc, last_seen_at desc, id asc
    limit 2
  `).all(params) as Array<{ id: string }>;

  if (matches.length === 1) return matches[0].id;
  if (matches.length === 0) {
    errors.push({ rowNumber, message: `Asset not found: ${accountId}/${service}/${resourceType}/${resourceName}` });
  } else {
    errors.push({ rowNumber, message: `Asset match is ambiguous: ${accountId}/${service}/${resourceType}/${resourceName}` });
  }
  return null;
}

function makeMetadataUpdate(
  rowValues: Partial<Record<CsvHeader, string>>,
  rowNumber: number,
  errors: AssetCsvImportError[],
): AssetMetadataUpdateInput {
  const input: AssetMetadataUpdateInput = {};

  for (const [csvField, metadataField] of Object.entries(METADATA_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(rowValues, csvField)) continue;
    const rawValue = rowValues[csvField as CsvHeader] ?? '';
    if (metadataField === 'containsPersonalInfo') {
      const parsed = parseContainsPersonalInfo(rawValue);
      if (parsed.valid) {
        input.containsPersonalInfo = parsed.value;
      } else {
        errors.push({ rowNumber, message: `Invalid contains_personal_info value: ${rawValue}` });
      }
      continue;
    }
    input[metadataField] = rawValue.trim();
  }

  return input;
}

function parseContainsPersonalInfo(value: string): { valid: true; value: boolean | null } | { valid: false } {
  const normalized = normalizeBooleanValue(value);
  if (normalized === '' || normalized === 'null' || normalized === 'unknown') return { valid: true, value: null };
  if (['true', 'yes', 'y', '1', '있음', '유', '예'].includes(normalized)) return { valid: true, value: true };
  if (['false', 'no', 'n', '0', '없음', '무', '아니오'].includes(normalized)) return { valid: true, value: false };
  return { valid: false };
}

function formatNullableBoolean(value: number | null): string {
  if (value === null) return '';
  return value === 1 ? 'true' : 'false';
}

function cleanMatchValue(value: string | undefined): string {
  return value?.trim() ?? '';
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeBooleanValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '');
}
