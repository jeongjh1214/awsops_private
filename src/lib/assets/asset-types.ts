export type AssetFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multi_select'
  | 'boolean'
  | 'date'
  | 'number'
  | 'url'
  | 'owner';

export interface AssetIdentityInput {
  provider: 'aws';
  accountId: string;
  region: string;
  service: string;
  resourceType: string;
  resourceId: string;
}

export interface AssetRecord extends AssetIdentityInput {
  id: string;
  accountName: string;
  resourceName: string;
  arn: string;
  status: string;
  nativeState: string;
  tags: Record<string, unknown>;
  sourceTable: string;
  sourceUpdatedAt: string;
  firstDiscoveredAt: string;
  lastSeenAt: string;
  isActive: boolean;
  lastHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetMetadata {
  assetId: string;
  ownerTeam: string;
  ownerPerson: string;
  businessSystem: string;
  moduleName: string;
  phase: string;
  purpose: string;
  criticality: string;
  securityGrade: string;
  costCenter: string;
  containsPersonalInfo: boolean | null;
  remarks: string;
  updatedBy: string;
  updatedAt: string;
}

export interface AssetCustomFieldDefinition {
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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetChangeEvent {
  id: string;
  assetId: string;
  eventType:
    | 'discovered'
    | 'rediscovered'
    | 'changed'
    | 'missing'
    | 'restored'
    | 'metadata_updated'
    | 'custom_field_updated'
    | 'custom_field_definition_changed';
  eventSource: 'sync' | 'user' | 'import' | 'admin';
  summary: string;
  beforeJson: string;
  afterJson: string;
  createdBy: string;
  createdAt: string;
}
