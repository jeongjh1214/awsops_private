'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import StatusBadge from '@/components/dashboard/StatusBadge';
import DataTable from '@/components/table/DataTable';
import { useAccountContext } from '@/contexts/AccountContext';
import { useLanguage } from '@/lib/i18n/LanguageContext';
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  Database,
  RefreshCw,
  Save,
  Search,
  Tags,
  X,
} from 'lucide-react';

type AssetRow = {
  id: string;
  account_id: string;
  account_name: string;
  region: string;
  service: string;
  resource_type: string;
  resource_name: string;
  status: string;
  last_seen_at: string;
  is_active: number;
  owner_team: string | null;
  module_name: string | null;
  phase: string | null;
};

type AssetMetadata = {
  owner_team: string;
  owner_person: string;
  business_system: string;
  module_name: string;
  phase: string;
  purpose: string;
  criticality: string;
  security_grade: string;
  cost_center: string;
  contains_personal_info: number | null;
  remarks: string;
  updated_by: string;
  metadata_updated_at: string;
};

type AssetDetail = AssetRow & {
  arn: string;
  provider: string;
  resource_id: string;
  native_state: string;
  source_table: string;
  source_updated_at: string;
  first_discovered_at: string;
  updated_at: string;
  metadata: AssetMetadata;
  customFields: CustomFieldValue[];
  events: Array<{ id: string; event_type: string; summary: string; created_at: string }>;
};

type CustomFieldValue = {
  id: string;
  key: string;
  label: string;
  type: string;
  value_json: string;
  updated_at: string;
};

type CustomFieldDefinition = {
  id: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  active: boolean;
};

type AssetListResponse = {
  rows: AssetRow[];
  total: number;
  limit: number;
  offset: number;
};

type SyncFailure = {
  resourceType: string;
  error: string;
};

type SyncSummary = {
  selected: string[];
  unsupported: string[];
  discovered: number;
  changed: number;
  rediscovered: number;
  missing: number;
  failed: SyncFailure[];
  skipped?: boolean;
  reason?: string;
};

type MetadataForm = {
  ownerTeam: string;
  ownerPerson: string;
  businessSystem: string;
  moduleName: string;
  phase: string;
  purpose: string;
  criticality: string;
  securityGrade: string;
  costCenter: string;
  containsPersonalInfo: 'true' | 'false' | 'unknown';
  remarks: string;
};

const EMPTY_FORM: MetadataForm = {
  ownerTeam: '',
  ownerPerson: '',
  businessSystem: '',
  moduleName: 'unknown',
  phase: 'unknown',
  purpose: '',
  criticality: '',
  securityGrade: '',
  costCenter: '',
  containsPersonalInfo: 'unknown',
  remarks: '',
};

const PHASE_OPTIONS = ['', 'unknown', 'dev', 'test', 'stage', 'prod'];
const CRITICALITY_OPTIONS = ['', 'low', 'medium', 'high', 'critical'];
const SECURITY_GRADE_OPTIONS = ['', 'public', 'internal', 'confidential', 'restricted'];

export default function AssetsPage() {
  const { t } = useLanguage();
  const { currentAccountId } = useAccountContext();
  const [rows, setRows] = useState<AssetRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [syncSummary, setSyncSummary] = useState<SyncSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customFields, setCustomFields] = useState<CustomFieldDefinition[]>([]);
  const [form, setForm] = useState<MetadataForm>(EMPTY_FORM);
  const [filters, setFilters] = useState({
    q: '',
    service: '',
    phase: '',
    metadataMissing: '',
    active: '',
  });

  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const fetchJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(url, init);
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      throw new Error(t('assets.invalidJson'));
    }

    if (!res.ok) {
      const message = data && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error)
        : `${res.status} ${res.statusText}`;
      throw new Error(message);
    }

    return data as T;
  }, [t]);

  const fetchAssets = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (currentAccountId && currentAccountId !== '__all__') params.set('accountId', currentAccountId);
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.set(key, value);
      });
      const data = await fetchJson<AssetListResponse>(`/awsops/api/assets?${params.toString()}`);
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
    } catch (err) {
      setRows([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : t('assets.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, fetchJson, filters, t]);

  const fetchCustomFields = useCallback(async () => {
    try {
      const data = await fetchJson<{ fields: CustomFieldDefinition[] }>('/awsops/api/assets/custom-fields');
      setCustomFields(data.fields || []);
    } catch {
      setCustomFields([]);
    }
  }, [fetchJson]);

  const fetchDetail = useCallback(async (assetId: string) => {
    setDetailLoading(true);
    setError('');
    try {
      const data = await fetchJson<AssetDetail>(`/awsops/api/assets/${encodeURIComponent(assetId)}`);
      setDetail(data);
      setForm(metadataToForm(data.metadata));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('assets.detailFailed'));
    } finally {
      setDetailLoading(false);
    }
  }, [fetchJson, t]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  useEffect(() => {
    fetchCustomFields();
  }, [fetchCustomFields]);

  useEffect(() => {
    if (selectedId) fetchDetail(selectedId);
  }, [fetchDetail, selectedId]);

  const serviceOptions = useMemo(() => uniqueValues(rows || [], 'service'), [rows]);
  const phaseOptions = useMemo(() => {
    const options = uniqueValues(rows || [], 'phase').filter(Boolean);
    return Array.from(new Set([...PHASE_OPTIONS.filter(Boolean), ...options]));
  }, [rows]);

  const stats = useMemo(() => {
    const list = rows || [];
    const active = list.filter((row) => row.is_active === 1).length;
    const inactive = list.filter((row) => row.is_active !== 1).length;
    const missingMetadata = list.filter(isMetadataMissing).length;
    return { active, inactive, missingMetadata };
  }, [rows]);

  const columns = useMemo(() => [
    {
      key: 'account_name',
      label: t('assets.account'),
      render: (value: string, row: AssetRow) => (
        <div className="min-w-40">
          <p className="text-gray-200 truncate">{value || t('assets.unnamedAccount')}</p>
          <p className="text-xs text-gray-500 font-mono truncate">{row.account_id || '-'}</p>
        </div>
      ),
    },
    { key: 'service', label: t('assets.service') },
    { key: 'resource_type', label: t('assets.resourceType') },
    {
      key: 'resource_name',
      label: t('assets.resourceName'),
      render: (value: string, row: AssetRow) => (
        <div className="min-w-52">
          <p className="text-gray-200 truncate">{value || row.id}</p>
          <p className="text-xs text-gray-500 font-mono truncate">{row.id}</p>
        </div>
      ),
    },
    { key: 'region', label: t('assets.region') },
    {
      key: 'status',
      label: t('assets.status'),
      render: (value: string) => <StatusBadge status={value || t('common.unknown')} />,
    },
    {
      key: 'owner_team',
      label: t('assets.ownerTeam'),
      render: (value: string | null) => value || <span className="text-gray-600">-</span>,
    },
    {
      key: 'module_name',
      label: t('assets.moduleName'),
      render: (value: string | null) => value || <span className="text-gray-600">-</span>,
    },
    {
      key: 'phase',
      label: t('assets.phase'),
      render: (value: string | null) => value || <span className="text-gray-600">unknown</span>,
    },
    {
      key: 'last_seen_at',
      label: t('assets.lastSeenAt'),
      render: (value: string) => formatDate(value),
    },
  ], [t]);

  const runSync = async () => {
    setSyncing(true);
    setError('');
    setSyncSummary(null);
    try {
      const data = await fetchJson<{ ok: boolean; summary: SyncSummary }>('/awsops/api/assets?action=sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setSyncSummary(data.summary);
      await fetchAssets();
    } catch (err) {
      const message = err instanceof Error ? err.message : t('assets.syncFailed');
      setSyncSummary({
        selected: [],
        unsupported: [],
        discovered: 0,
        changed: 0,
        rediscovered: 0,
        missing: 0,
        failed: [{ resourceType: 'sync', error: message }],
      });
      setError(message);
    } finally {
      setSyncing(false);
    }
  };

  const saveMetadata = async () => {
    if (!selectedId) return;
    setSaving(true);
    setError('');
    try {
      await fetchJson<AssetDetail>(`/awsops/api/assets/${encodeURIComponent(selectedId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToPayload(form)),
      });
      await fetchDetail(selectedId);
      await fetchAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('assets.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const clearFilters = () => {
    setFilters({ q: '', service: '', phase: '', metadataMissing: '', active: '' });
  };

  const hasFilters = Object.values(filters).some(Boolean);
  const hasRows = (rows?.length || 0) > 0;

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <Header title={t('assets.title')} subtitle={t('assets.subtitle')} onRefresh={fetchAssets} />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatsCard label={t('assets.total')} value={total} icon={Boxes} color="cyan" />
        <StatsCard label={t('assets.active')} value={stats.active} icon={CheckCircle2} color="green" />
        <StatsCard label={t('assets.missingMetadata')} value={stats.missingMetadata} icon={Tags} color="orange" />
        <StatsCard label={t('assets.inactive')} value={stats.inactive} icon={Database} color="purple" />
      </div>

      <section className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        {syncSummary && (
          <div className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-3 text-sm text-gray-300">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-medium text-white">{t('assets.syncSummary')}</span>
              <span>{t('assets.discovered')}: {syncSummary.discovered}</span>
              <span>{t('assets.changed')}: {syncSummary.changed}</span>
              <span>{t('assets.rediscovered')}: {syncSummary.rediscovered}</span>
              <span>{t('assets.missing')}: {syncSummary.missing}</span>
              <span className={syncSummary.failed.length ? 'text-accent-red' : 'text-accent-green'}>
                {t('assets.failed')}: {syncSummary.failed.length}
              </span>
              {syncSummary.skipped && <span className="text-accent-orange">{syncSummary.reason}</span>}
            </div>
            {syncSummary.failed.length > 0 && (
              <div className="mt-2 space-y-1 text-xs text-accent-red">
                {syncSummary.failed.map((failure, index) => (
                  <p key={`${failure.resourceType}-${index}`}>{failure.resourceType}: {failure.error}</p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              type="text"
              value={filters.q}
              onChange={(event) => setFilter('q', event.target.value)}
              placeholder={t('assets.searchPlaceholder')}
              className="w-full sm:w-72 bg-navy-800 border border-navy-600 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:ring-accent-cyan focus:border-accent-cyan focus:outline-none"
            />
          </div>
          <select
            value={filters.service}
            onChange={(event) => setFilter('service', event.target.value)}
            className="min-w-32 max-w-full bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:ring-accent-cyan focus:border-accent-cyan"
          >
            <option value="">{t('assets.allServices')}</option>
            {serviceOptions.map((service) => <option key={service} value={service}>{service}</option>)}
          </select>
          <select
            value={filters.phase}
            onChange={(event) => setFilter('phase', event.target.value)}
            className="min-w-32 max-w-full bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:ring-accent-cyan focus:border-accent-cyan"
          >
            <option value="">{t('assets.allPhases')}</option>
            {phaseOptions.map((phase) => <option key={phase} value={phase}>{phase}</option>)}
          </select>
          <select
            value={filters.metadataMissing}
            onChange={(event) => setFilter('metadataMissing', event.target.value)}
            className="min-w-40 max-w-full bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:ring-accent-cyan focus:border-accent-cyan"
          >
            <option value="">{t('assets.allMetadata')}</option>
            <option value="true">{t('assets.metadataMissingOnly')}</option>
            <option value="false">{t('assets.metadataCompleteOnly')}</option>
          </select>
          <select
            value={filters.active}
            onChange={(event) => setFilter('active', event.target.value)}
            className="min-w-32 max-w-full bg-navy-800 border border-navy-600 rounded-lg px-3 py-2 text-sm text-gray-200 focus:ring-accent-cyan focus:border-accent-cyan"
          >
            <option value="">{t('assets.allActivity')}</option>
            <option value="true">{t('assets.activeOnly')}</option>
            <option value="false">{t('assets.inactiveOnly')}</option>
          </select>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-300 hover:border-accent-cyan/50 hover:text-accent-cyan transition-colors"
            >
              <X size={14} />
              <span className="truncate">{t('assets.clearFilters')}</span>
            </button>
          )}
          <button
            onClick={fetchAssets}
            disabled={loading}
            className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-300 hover:border-accent-cyan/50 hover:text-accent-cyan disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span className="truncate">{t('assets.reload')}</span>
          </button>
          <button
            onClick={runSync}
            disabled={syncing}
            className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-3 py-2 text-sm text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            <span className="truncate">{syncing ? t('assets.syncing') : t('assets.sync')}</span>
          </button>
        </div>
      </section>

      {loading || hasRows ? (
        <DataTable
          columns={columns}
          data={loading ? undefined : rows || []}
          onRowClick={(row) => {
            setSelectedId(row.id);
            setDetail(null);
          }}
        />
      ) : (
        <div className="rounded-lg border border-navy-600 bg-navy-800 px-6 py-12 text-center">
          <Database size={32} className="mx-auto text-gray-600" />
          <p className="mt-3 text-sm font-medium text-gray-300">{t('assets.emptyTitle')}</p>
          <p className="mt-1 text-sm text-gray-500">{t('assets.emptyDescription')}</p>
          <button
            onClick={runSync}
            disabled={syncing}
            className="mt-5 inline-flex max-w-full items-center justify-center gap-2 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-4 py-2 text-sm text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-60 transition-colors"
          >
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
            <span className="truncate">{syncing ? t('assets.syncing') : t('assets.sync')}</span>
          </button>
        </div>
      )}

      {selectedId && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40">
          <button
            className="flex-1 cursor-default"
            aria-label={t('common.close')}
            onClick={() => setSelectedId(null)}
          />
          <aside className="h-full w-full max-w-2xl overflow-y-auto border-l border-navy-600 bg-navy-900 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-navy-600 bg-navy-900 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-mono uppercase text-accent-cyan">{detail?.service || t('assets.assetDetail')}</p>
                <h2 className="mt-1 truncate text-xl font-semibold text-white">
                  {detail?.resource_name || selectedId}
                </h2>
                <p className="mt-1 truncate text-xs font-mono text-gray-500">{selectedId}</p>
              </div>
              <button
                onClick={() => setSelectedId(null)}
                className="rounded-lg p-2 text-gray-500 hover:bg-navy-700 hover:text-gray-200 transition-colors"
                title={t('common.close')}
              >
                <X size={18} />
              </button>
            </div>

            {detailLoading && (
              <div className="px-5 py-8 text-sm text-gray-400">{t('common.loading')}</div>
            )}

            {!detailLoading && detail && (
              <div className="space-y-6 px-5 py-5">
                <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                  <ReadOnly label={t('assets.account')} value={`${detail.account_name || t('assets.unnamedAccount')} (${detail.account_id})`} />
                  <ReadOnly label={t('assets.region')} value={detail.region} />
                  <ReadOnly label={t('assets.resourceType')} value={detail.resource_type} />
                  <ReadOnly label={t('assets.status')} value={<StatusBadge status={detail.status || t('common.unknown')} />} />
                  <ReadOnly label={t('assets.resourceId')} value={detail.resource_id} />
                  <ReadOnly label={t('assets.lastSeenAt')} value={formatDate(detail.last_seen_at)} />
                  <ReadOnly label="ARN" value={detail.arn || '-'} wide />
                </section>

                <section className="space-y-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-white">{t('assets.metadata')}</h3>
                    <button
                      onClick={saveMetadata}
                      disabled={saving}
                      className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-3 py-2 text-sm text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-60 transition-colors"
                    >
                      <Save size={14} />
                      <span className="truncate">{saving ? t('assets.saving') : t('assets.save')}</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <TextField label={t('assets.ownerTeam')} value={form.ownerTeam} onChange={(value) => setForm((prev) => ({ ...prev, ownerTeam: value }))} />
                    <TextField label={t('assets.ownerPerson')} value={form.ownerPerson} onChange={(value) => setForm((prev) => ({ ...prev, ownerPerson: value }))} />
                    <TextField label={t('assets.businessSystem')} value={form.businessSystem} onChange={(value) => setForm((prev) => ({ ...prev, businessSystem: value }))} />
                    <TextField label={t('assets.moduleName')} value={form.moduleName} onChange={(value) => setForm((prev) => ({ ...prev, moduleName: value }))} />
                    <SelectField label={t('assets.phase')} value={form.phase} options={PHASE_OPTIONS.filter(Boolean)} onChange={(value) => setForm((prev) => ({ ...prev, phase: value }))} />
                    <SelectField label={t('assets.criticality')} value={form.criticality} options={CRITICALITY_OPTIONS} onChange={(value) => setForm((prev) => ({ ...prev, criticality: value }))} />
                    <SelectField label={t('assets.securityGrade')} value={form.securityGrade} options={SECURITY_GRADE_OPTIONS} onChange={(value) => setForm((prev) => ({ ...prev, securityGrade: value }))} />
                    <TextField label={t('assets.costCenter')} value={form.costCenter} onChange={(value) => setForm((prev) => ({ ...prev, costCenter: value }))} />
                    <SelectField
                      label={t('assets.containsPersonalInfo')}
                      value={form.containsPersonalInfo}
                      options={['unknown', 'true', 'false']}
                      labelFor={(value) => value === 'unknown' ? t('common.unknown') : value === 'true' ? t('common.yes') : t('common.no')}
                      onChange={(value) => setForm((prev) => ({ ...prev, containsPersonalInfo: value as MetadataForm['containsPersonalInfo'] }))}
                    />
                    <TextField label={t('assets.purpose')} value={form.purpose} onChange={(value) => setForm((prev) => ({ ...prev, purpose: value }))} />
                    <TextAreaField label={t('assets.remarks')} value={form.remarks} onChange={(value) => setForm((prev) => ({ ...prev, remarks: value }))} wide />
                  </div>
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-white">{t('assets.customFields')}</h3>
                  {detail.customFields.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      {detail.customFields.map((field) => (
                        <ReadOnly key={field.id} label={field.label} value={formatCustomFieldValue(field.value_json)} />
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-3 text-sm text-gray-500">
                      {customFields.length > 0
                        ? t('assets.customFieldsAvailable', { count: customFields.length })
                        : t('assets.noCustomFields')}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-white">{t('assets.recentEvents')}</h3>
                  {detail.events.length > 0 ? (
                    <div className="space-y-2">
                      {detail.events.slice(0, 5).map((event) => (
                        <div key={event.id} className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-medium text-gray-200">{event.event_type}</span>
                            <span className="text-xs text-gray-500">{formatDate(event.created_at)}</span>
                          </div>
                          <p className="mt-1 text-gray-400">{event.summary}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">{t('assets.noEvents')}</p>
                  )}
                </section>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function uniqueValues<T extends Record<string, unknown>>(rows: T[], key: keyof T): string[] {
  return Array.from(new Set(rows.map((row) => String(row[key] || '')).filter(Boolean))).sort();
}

function isMetadataMissing(row: AssetRow): boolean {
  return !row.owner_team || !row.module_name || !row.phase || row.phase === 'unknown';
}

function metadataToForm(metadata: AssetMetadata): MetadataForm {
  return {
    ownerTeam: metadata.owner_team || '',
    ownerPerson: metadata.owner_person || '',
    businessSystem: metadata.business_system || '',
    moduleName: metadata.module_name || '',
    phase: metadata.phase || 'unknown',
    purpose: metadata.purpose || '',
    criticality: metadata.criticality || '',
    securityGrade: metadata.security_grade || '',
    costCenter: metadata.cost_center || '',
    containsPersonalInfo: metadata.contains_personal_info === null
      ? 'unknown'
      : metadata.contains_personal_info === 1 ? 'true' : 'false',
    remarks: metadata.remarks || '',
  };
}

function formToPayload(form: MetadataForm) {
  return {
    ownerTeam: form.ownerTeam,
    ownerPerson: form.ownerPerson,
    businessSystem: form.businessSystem,
    moduleName: form.moduleName,
    phase: form.phase || 'unknown',
    purpose: form.purpose,
    criticality: form.criticality,
    securityGrade: form.securityGrade,
    costCenter: form.costCenter,
    containsPersonalInfo: form.containsPersonalInfo === 'unknown' ? null : form.containsPersonalInfo === 'true',
    remarks: form.remarks,
    updatedBy: 'operator',
  };
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatCustomFieldValue(value: string): string {
  if (!value) return '-';
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.join(', ');
    if (parsed === null || parsed === undefined || parsed === '') return '-';
    if (typeof parsed === 'object') return JSON.stringify(parsed);
    return String(parsed);
  } catch {
    return value;
  }
}

function ReadOnly({
  label,
  value,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : ''}>
      <p className="text-xs text-gray-500">{label}</p>
      <div className="mt-1 break-words text-gray-200">{value || '-'}</div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 focus:border-accent-cyan focus:outline-none"
      />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  wide,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="text-xs text-gray-500">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="mt-1 w-full resize-y rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 focus:border-accent-cyan focus:outline-none"
      />
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
  labelFor,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  labelFor?: (value: string) => string;
}) {
  return (
    <label className="block">
      <span className="text-xs text-gray-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 focus:border-accent-cyan focus:outline-none"
      >
        {options.map((option) => (
          <option key={option || 'empty'} value={option}>{labelFor ? labelFor(option) : option || '-'}</option>
        ))}
      </select>
    </label>
  );
}
