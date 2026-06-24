import { randomUUID } from 'crypto';
import type { AssetDb } from './asset-db';
import type { AssetCustomFieldDefinition, AssetFieldType } from './asset-types';

export interface CreateCustomFieldInput {
  key: string;
  label: string;
  type: AssetFieldType | string;
  options?: string[];
  required?: boolean;
  appliesToServices?: string[];
  appliesToResourceTypes?: string[];
  displayOrder?: number;
  active?: boolean;
  createdBy?: string;
}

export interface UpdateCustomFieldInput {
  key?: string;
  label?: string;
  type?: AssetFieldType | string;
  options?: string[];
  required?: boolean;
  appliesToServices?: string[];
  appliesToResourceTypes?: string[];
  displayOrder?: number;
  active?: boolean;
  updatedBy?: string;
}

interface CustomFieldSqlRow {
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
  created_by: string;
  created_at: string;
  updated_at: string;
}

const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
const ALLOWED_FIELD_TYPES = new Set<AssetFieldType>([
  'text',
  'textarea',
  'select',
  'multi_select',
  'boolean',
  'date',
  'number',
  'url',
  'owner',
]);

export function createCustomField(
  db: AssetDb,
  input: CreateCustomFieldInput,
  now: string = new Date().toISOString(),
): AssetCustomFieldDefinition {
  const field = normalizeCreateInput(input, now);

  db.prepare(`
    insert into asset_custom_field_definitions (
      id,
      key,
      label,
      type,
      options_json,
      required,
      applies_to_services_json,
      applies_to_resource_types_json,
      display_order,
      active,
      created_by,
      created_at,
      updated_at
    ) values (
      @id,
      @key,
      @label,
      @type,
      @optionsJson,
      @requiredSql,
      @appliesToServicesJson,
      @appliesToResourceTypesJson,
      @displayOrder,
      @activeSql,
      @createdBy,
      @createdAt,
      @updatedAt
    )
  `).run(fieldToSqlParams(field));

  // Definition-level audit needs a separate global audit table because
  // asset_change_events.asset_id is constrained to real asset records.
  return field;
}

export function listCustomFields(
  db: AssetDb,
  includeInactive = false,
): AssetCustomFieldDefinition[] {
  const rows = db.prepare(`
    select *
    from asset_custom_field_definitions
    ${includeInactive ? '' : 'where active = 1'}
    order by display_order asc, label asc
  `).all() as CustomFieldSqlRow[];

  return rows.map(sqlRowToCustomField);
}

export function updateCustomField(
  db: AssetDb,
  id: string,
  input: UpdateCustomFieldInput,
  now: string = new Date().toISOString(),
): AssetCustomFieldDefinition | null {
  const existing = getCustomFieldRow(db, id);
  if (!existing) return null;

  if (Object.prototype.hasOwnProperty.call(input, 'key') && input.key !== undefined) {
    throw new Error('key cannot be changed');
  }

  const before = sqlRowToCustomField(existing);
  const after: AssetCustomFieldDefinition = {
    ...before,
    label: shouldApply(input, 'label') ? validateLabel(input.label) : before.label,
    type: shouldApply(input, 'type') ? validateType(input.type) : before.type,
    options: shouldApply(input, 'options') ? validateStringArray(input.options, 'options') : before.options,
    required: shouldApply(input, 'required') ? validateBoolean(input.required, 'required') : before.required,
    appliesToServices: shouldApply(input, 'appliesToServices')
      ? validateStringArray(input.appliesToServices, 'appliesToServices')
      : before.appliesToServices,
    appliesToResourceTypes: shouldApply(input, 'appliesToResourceTypes')
      ? validateStringArray(input.appliesToResourceTypes, 'appliesToResourceTypes')
      : before.appliesToResourceTypes,
    displayOrder: shouldApply(input, 'displayOrder')
      ? validateDisplayOrder(input.displayOrder)
      : before.displayOrder,
    active: shouldApply(input, 'active') ? validateBoolean(input.active, 'active') : before.active,
    updatedAt: now,
  };

  db.prepare(`
    update asset_custom_field_definitions set
      label = @label,
      type = @type,
      options_json = @optionsJson,
      required = @requiredSql,
      applies_to_services_json = @appliesToServicesJson,
      applies_to_resource_types_json = @appliesToResourceTypesJson,
      display_order = @displayOrder,
      active = @activeSql,
      updated_at = @updatedAt
    where id = @id
  `).run(fieldToSqlParams(after));

  return after;
}

export function deactivateCustomField(
  db: AssetDb,
  id: string,
  _updatedBy = 'admin',
  now: string = new Date().toISOString(),
): AssetCustomFieldDefinition | null {
  return updateCustomField(db, id, { active: false, updatedBy: _updatedBy }, now);
}

function normalizeCreateInput(
  input: CreateCustomFieldInput,
  now: string,
): AssetCustomFieldDefinition {
  return {
    id: randomUUID(),
    key: validateKey(input.key),
    label: validateLabel(input.label),
    type: validateType(input.type),
    options: validateStringArray(input.options ?? [], 'options'),
    required: validateBoolean(input.required ?? false, 'required'),
    appliesToServices: validateStringArray(input.appliesToServices ?? [], 'appliesToServices'),
    appliesToResourceTypes: validateStringArray(input.appliesToResourceTypes ?? [], 'appliesToResourceTypes'),
    displayOrder: validateDisplayOrder(input.displayOrder ?? 0),
    active: validateBoolean(input.active ?? true, 'active'),
    createdBy: validateOptionalString(input.createdBy, 'createdBy') || 'admin',
    createdAt: now,
    updatedAt: now,
  };
}

function getCustomFieldRow(db: AssetDb, id: string): CustomFieldSqlRow | undefined {
  return db.prepare('select * from asset_custom_field_definitions where id = @id')
    .get({ id }) as CustomFieldSqlRow | undefined;
}

function sqlRowToCustomField(row: CustomFieldSqlRow): AssetCustomFieldDefinition {
  return {
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
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fieldToSqlParams(field: AssetCustomFieldDefinition): Record<string, unknown> {
  return {
    id: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    optionsJson: JSON.stringify(field.options),
    requiredSql: field.required ? 1 : 0,
    appliesToServicesJson: JSON.stringify(field.appliesToServices),
    appliesToResourceTypesJson: JSON.stringify(field.appliesToResourceTypes),
    displayOrder: field.displayOrder,
    activeSql: field.active ? 1 : 0,
    createdBy: field.createdBy,
    createdAt: field.createdAt,
    updatedAt: field.updatedAt,
  };
}

function validateKey(value: unknown): string {
  if (typeof value !== 'string' || !FIELD_KEY_PATTERN.test(value)) {
    throw new Error('key must match /^[a-z][a-z0-9_]{1,63}$/');
  }
  return value;
}

function validateLabel(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('label must be a non-empty string');
  }
  return value;
}

function validateType(value: unknown): AssetFieldType {
  if (typeof value !== 'string' || !ALLOWED_FIELD_TYPES.has(value as AssetFieldType)) {
    throw new Error('type must be a supported asset field type');
  }
  return value as AssetFieldType;
}

function validateStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be a string array`);
  }
  return [...value];
}

function validateBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function validateDisplayOrder(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('displayOrder must be a finite number');
  }
  return Math.trunc(value);
}

function validateOptionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return value;
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

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function shouldApply<T extends object>(value: T, key: keyof T): boolean {
  return hasOwn(value, key) && value[key] !== undefined;
}
