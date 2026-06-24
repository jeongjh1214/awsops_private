'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '@/components/layout/Header';
import StatsCard from '@/components/dashboard/StatsCard';
import StatusBadge from '@/components/dashboard/StatusBadge';
import { useAccountContext } from '@/contexts/AccountContext';
import {
  AlertCircle,
  CheckCircle2,
  Database,
  Download,
  History,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';

type NullableBoolean = 'true' | 'false' | 'unknown';

type S3GovernanceRow = {
  stable_key: string;
  account_id: string;
  account_name: string;
  phase: string;
  bucket_name: string;
  owner_team: string;
  purpose: string;
  history: string;
  contains_personal_info: number | null;
  pii_retention_aware: number | null;
  pii_retention_applied: number | null;
  pii_retention_period: string;
  remarks: string;
  updated_by: string;
  updated_at: string;
  created_at: string;
  asset_id: string | null;
  asset_region: string | null;
  asset_status: string | null;
  asset_is_active: number | null;
  asset_last_seen_at: string | null;
};

type S3GovernanceEvent = {
  id: string;
  event_type: string;
  summary: string;
  before_json: string;
  after_json: string;
  created_by: string;
  created_at: string;
};

type S3GovernanceDetail = S3GovernanceRow & {
  events: S3GovernanceEvent[];
};

type S3GovernanceListResponse = {
  rows: S3GovernanceRow[];
  total: number;
  limit: number;
  offset: number;
};

type GovernanceForm = {
  accountId: string;
  accountName: string;
  phase: string;
  bucketName: string;
  ownerTeam: string;
  purpose: string;
  history: string;
  containsPersonalInfo: NullableBoolean;
  piiRetentionAware: NullableBoolean;
  piiRetentionApplied: NullableBoolean;
  piiRetentionPeriod: string;
  remarks: string;
};

const EMPTY_FORM: GovernanceForm = {
  accountId: '',
  accountName: '',
  phase: '',
  bucketName: '',
  ownerTeam: '',
  purpose: '',
  history: '',
  containsPersonalInfo: 'unknown',
  piiRetentionAware: 'unknown',
  piiRetentionApplied: 'unknown',
  piiRetentionPeriod: '',
  remarks: '',
};

const PHASE_OPTIONS = ['', 'local', 'dev', 'test', 'stage', 'prod'];

export default function S3GovernancePage() {
  const { currentAccountId } = useAccountContext();
  const [rows, setRows] = useState<S3GovernanceRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detail, setDetail] = useState<S3GovernanceDetail | null>(null);
  const [form, setForm] = useState<GovernanceForm>(EMPTY_FORM);
  const [filters, setFilters] = useState({
    q: '',
    phase: '',
    active: '',
    containsPersonalInfo: '',
    piiRetentionApplied: '',
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
      throw new Error('응답 JSON을 읽을 수 없습니다.');
    }

    if (!res.ok) {
      const message = data && typeof data === 'object' && 'error' in data
        ? String((data as { error?: unknown }).error)
        : `${res.status} ${res.statusText}`;
      throw new Error(message);
    }

    return data as T;
  }, []);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '1000' });
      if (currentAccountId && currentAccountId !== '__all__') params.set('accountId', currentAccountId);
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params.set(key, value);
      });
      const data = await fetchJson<S3GovernanceListResponse>(`/awsops/api/s3-governance?${params.toString()}`);
      setRows(data.rows || []);
      setTotal(Number(data.total) || 0);
    } catch (err) {
      setRows([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : 'S3 관리대장을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [currentAccountId, fetchJson, filters]);

  const fetchDetail = useCallback(async (stableKey: string) => {
    setError('');
    try {
      const data = await fetchJson<S3GovernanceDetail>(`/awsops/api/s3-governance/${encodeURIComponent(stableKey)}`);
      setDetail(data);
      setForm(rowToForm(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'S3 관리대장 상세를 불러오지 못했습니다.');
    }
  }, [fetchJson]);

  useEffect(() => {
    fetchRows();
  }, [fetchRows]);

  useEffect(() => {
    if (!selectedKey) {
      setDetail(null);
      return;
    }
    fetchDetail(selectedKey);
  }, [fetchDetail, selectedKey]);

  const stats = useMemo(() => {
    const list = rows || [];
    return {
      active: list.filter((row) => row.asset_is_active === 1).length,
      missing: list.filter((row) => row.asset_is_active !== 1).length,
      personalInfo: list.filter((row) => row.contains_personal_info === 1).length,
      retentionGap: list.filter((row) => row.pii_retention_applied === 0).length,
    };
  }, [rows]);

  const openNew = () => {
    setSelectedKey('__new__');
    setDetail(null);
    setForm({
      ...EMPTY_FORM,
      accountId: currentAccountId && currentAccountId !== '__all__' ? currentAccountId : '',
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const target = selectedKey && selectedKey !== '__new__'
        ? `/awsops/api/s3-governance/${encodeURIComponent(selectedKey)}`
        : '/awsops/api/s3-governance';
      const method = selectedKey && selectedKey !== '__new__' ? 'PATCH' : 'POST';
      const data = await fetchJson<S3GovernanceDetail | { ok: true; record: S3GovernanceRow | null }>(target, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formToPayload(form)),
      });

      const stableKey = 'stable_key' in data ? data.stable_key : data.record?.stable_key;
      if (stableKey) {
        setSelectedKey(stableKey);
        await fetchDetail(stableKey);
      }
      await fetchRows();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'S3 관리대장 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = () => {
    const params = new URLSearchParams({ action: 'export', limit: '1000' });
    if (currentAccountId && currentAccountId !== '__all__') params.set('accountId', currentAccountId);
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    window.location.href = `/awsops/api/s3-governance?${params.toString()}`;
  };

  const clearFilters = () => {
    setFilters({ q: '', phase: '', active: '', containsPersonalInfo: '', piiRetentionApplied: '' });
  };

  const hasFilters = Object.values(filters).some(Boolean);

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      <Header title="S3 관리대장" subtitle="S3 버킷별 소유, 용도, 개인정보, 유효기간 적용 정보를 관리합니다" onRefresh={fetchRows} />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatsCard label="관리대장" value={total} icon={Database} color="cyan" />
        <StatsCard label="활성 버킷" value={stats.active} icon={CheckCircle2} color="green" />
        <StatsCard label="개인정보 포함" value={stats.personalInfo} icon={ShieldCheck} color="orange" />
        <StatsCard label="유효기간 미적용" value={stats.retentionGap} icon={AlertCircle} color="red" />
      </div>

      <section className="space-y-3">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600" />
            <input
              type="text"
              value={filters.q}
              onChange={(event) => setFilter('q', event.target.value)}
              placeholder="계정, 버킷, 담당조직, 용도 검색"
              className="w-full sm:w-80 bg-navy-800 border border-navy-600 rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:ring-accent-cyan focus:border-accent-cyan focus:outline-none"
            />
          </div>
          <select value={filters.phase} onChange={(event) => setFilter('phase', event.target.value)} className={selectClassName}>
            <option value="">전체 phase</option>
            {PHASE_OPTIONS.filter(Boolean).map((phase) => <option key={phase} value={phase}>{phase}</option>)}
          </select>
          <select value={filters.active} onChange={(event) => setFilter('active', event.target.value)} className={selectClassName}>
            <option value="">전체 상태</option>
            <option value="true">활성</option>
            <option value="false">삭제/미연결</option>
          </select>
          <select value={filters.containsPersonalInfo} onChange={(event) => setFilter('containsPersonalInfo', event.target.value)} className={selectClassName}>
            <option value="">개인정보 전체</option>
            <option value="true">있음</option>
            <option value="false">없음</option>
          </select>
          <select value={filters.piiRetentionApplied} onChange={(event) => setFilter('piiRetentionApplied', event.target.value)} className={selectClassName}>
            <option value="">유효기간 적용 전체</option>
            <option value="true">적용</option>
            <option value="false">미적용</option>
          </select>
          {hasFilters && (
            <button onClick={clearFilters} className={secondaryButtonClassName}>
              <X size={14} />
              <span className="truncate">필터 초기화</span>
            </button>
          )}
          <button onClick={fetchRows} disabled={loading} className={secondaryButtonClassName}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            <span className="truncate">새로고침</span>
          </button>
          <button onClick={exportCsv} className={secondaryButtonClassName}>
            <Download size={14} />
            <span className="truncate">CSV</span>
          </button>
          <button onClick={openNew} className={primaryButtonClassName}>
            <Plus size={14} />
            <span className="truncate">추가</span>
          </button>
        </div>
      </section>

      <S3GovernanceTable
        rows={loading ? null : rows || []}
        onSelect={(row) => setSelectedKey(row.stable_key)}
      />

      {selectedKey && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40">
          <button className="flex-1 cursor-default" aria-label="닫기" onClick={() => setSelectedKey(null)} />
          <aside className="h-full w-full max-w-3xl overflow-y-auto border-l border-navy-600 bg-navy-900 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-navy-600 bg-navy-900 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-mono uppercase text-accent-cyan">S3 Governance</p>
                <h2 className="mt-1 truncate text-xl font-semibold text-white">{form.bucketName || '새 버킷 관리대장'}</h2>
                <p className="mt-1 truncate text-xs font-mono text-gray-500">{form.accountId || 'account id'}</p>
              </div>
              <button onClick={() => setSelectedKey(null)} className="rounded-lg p-2 text-gray-500 hover:bg-navy-700 hover:text-gray-200 transition-colors" title="닫기">
                <X size={18} />
              </button>
            </div>

            <div className="space-y-6 px-5 py-5">
              <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <TextField label="account name" value={form.accountName} onChange={(value) => setForm((prev) => ({ ...prev, accountName: value }))} />
                <TextField label="accountid" value={form.accountId} disabled={selectedKey !== '__new__'} onChange={(value) => setForm((prev) => ({ ...prev, accountId: value }))} />
                <SelectField label="phase" value={form.phase} options={PHASE_OPTIONS} onChange={(value) => setForm((prev) => ({ ...prev, phase: value }))} />
                <TextField label="bucketname" value={form.bucketName} disabled={selectedKey !== '__new__'} onChange={(value) => setForm((prev) => ({ ...prev, bucketName: value }))} />
                <TextField label="담당조직" value={form.ownerTeam} onChange={(value) => setForm((prev) => ({ ...prev, ownerTeam: value }))} />
                <TextField label="용도" value={form.purpose} onChange={(value) => setForm((prev) => ({ ...prev, purpose: value }))} />
                <TextareaField label="이력" value={form.history} onChange={(value) => setForm((prev) => ({ ...prev, history: value }))} />
                <TextareaField label="비고" value={form.remarks} onChange={(value) => setForm((prev) => ({ ...prev, remarks: value }))} />
                <SelectField label="데이터 개인정보 유무 여부" value={form.containsPersonalInfo} options={['unknown', 'true', 'false']} labelFor={booleanLabel} onChange={(value) => setForm((prev) => ({ ...prev, containsPersonalInfo: value as NullableBoolean }))} />
                <SelectField label="개인정보 데이터 유효기간 인지여부" value={form.piiRetentionAware} options={['unknown', 'true', 'false']} labelFor={booleanLabel} onChange={(value) => setForm((prev) => ({ ...prev, piiRetentionAware: value as NullableBoolean }))} />
                <SelectField label="개인정보 데이터 유효기간 적용여부" value={form.piiRetentionApplied} options={['unknown', 'true', 'false']} labelFor={booleanLabel} onChange={(value) => setForm((prev) => ({ ...prev, piiRetentionApplied: value as NullableBoolean }))} />
                <TextField label="적용데이터 유효기간" value={form.piiRetentionPeriod} onChange={(value) => setForm((prev) => ({ ...prev, piiRetentionPeriod: value }))} />
              </section>

              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-gray-500">
                  {detail?.asset_is_active === 1 ? '수집된 활성 버킷과 연결됨' : '삭제되었거나 아직 수집 데이터와 연결되지 않음'}
                </div>
                <button onClick={save} disabled={saving} className={primaryButtonClassName}>
                  <Save size={14} />
                  <span className="truncate">{saving ? '저장 중' : '저장'}</span>
                </button>
              </div>

              <section className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <History size={16} />
                  <span>변경 이력</span>
                </div>
                {detail?.events?.length ? (
                  <div className="space-y-2">
                    {detail.events.map((event) => (
                      <div key={event.id} className="rounded-lg border border-navy-600 bg-navy-800 px-3 py-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm text-gray-200">{event.summary}</p>
                          <p className="text-xs text-gray-500">{formatDate(event.created_at)}</p>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">{event.created_by || 'unknown'} · {event.event_type}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-6 text-center text-sm text-gray-500">
                    저장 후 변경 이력이 표시됩니다.
                  </div>
                )}
              </section>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function S3GovernanceTable({ rows, onSelect }: {
  rows: S3GovernanceRow[] | null;
  onSelect: (row: S3GovernanceRow) => void;
}) {
  const headers = [
    'account name',
    'accountid',
    'phase',
    'bucketname',
    '담당조직',
    '용도',
    '이력',
    '데이터 개인정보 유무 여부',
    '개인정보 데이터 유효기간 인지여부',
    '개인정보 데이터 유효기간 적용여부',
    '적용데이터 유효기간',
    '비고',
    '상태',
  ];

  return (
    <div className="rounded-lg border border-navy-600 bg-navy-800 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1500px]">
          <thead>
            <tr className="bg-navy-700">
              {headers.map((header) => (
                <th key={header} className="px-4 py-3 text-left text-xs font-mono font-semibold uppercase tracking-wider text-accent-cyan">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows === null ? (
              Array.from({ length: 5 }).map((_, index) => (
                <tr key={index} className="border-b border-navy-600">
                  {headers.map((header) => (
                    <td key={header} className="px-4 py-3">
                      <div className="h-4 w-3/4 rounded bg-navy-700 animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length ? (
              rows.map((row) => (
                <tr key={row.stable_key} onClick={() => onSelect(row)} className="cursor-pointer border-b border-navy-600 hover:bg-navy-700 transition-colors">
                  <Cell mono={false} value={row.account_name || '-'} />
                  <Cell mono value={row.account_id} />
                  <Cell value={row.phase || '-'} />
                  <Cell mono value={row.bucket_name} />
                  <Cell value={row.owner_team || '-'} />
                  <Cell value={row.purpose || '-'} />
                  <Cell value={row.history || '-'} />
                  <Cell value={nullableBooleanLabel(row.contains_personal_info)} />
                  <Cell value={nullableBooleanLabel(row.pii_retention_aware)} />
                  <Cell value={nullableBooleanLabel(row.pii_retention_applied)} />
                  <Cell value={row.pii_retention_period || '-'} />
                  <Cell value={row.remarks || '-'} />
                  <td className="px-4 py-3 text-sm text-gray-300">
                    <StatusBadge status={row.asset_is_active === 1 ? 'active' : 'missing'} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={headers.length} className="px-4 py-12 text-center text-sm text-gray-500">
                  표시할 S3 관리대장 데이터가 없습니다.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Cell({ value, mono = false }: { value: string; mono?: boolean }) {
  return (
    <td className={`max-w-64 truncate px-4 py-3 text-sm text-gray-300 ${mono ? 'font-mono' : ''}`} title={value}>
      {value}
    </td>
  );
}

function TextField({ label, value, onChange, disabled = false }: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-gray-400">{label}</span>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 disabled:cursor-not-allowed disabled:opacity-60 focus:border-accent-cyan focus:outline-none focus:ring-accent-cyan"
      />
    </label>
  );
}

function TextareaField({ label, value, onChange }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 text-sm sm:col-span-2">
      <span className="text-gray-400">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="w-full resize-y rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 focus:border-accent-cyan focus:outline-none focus:ring-accent-cyan"
      />
    </label>
  );
}

function SelectField({ label, value, options, onChange, labelFor = (item) => item || '-' }: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
  labelFor?: (value: string) => string;
}) {
  return (
    <label className="space-y-1 text-sm">
      <span className="text-gray-400">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className={selectClassName}>
        {options.map((option) => <option key={option || 'empty'} value={option}>{labelFor(option)}</option>)}
      </select>
    </label>
  );
}

function rowToForm(row: S3GovernanceRow): GovernanceForm {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    phase: row.phase,
    bucketName: row.bucket_name,
    ownerTeam: row.owner_team,
    purpose: row.purpose,
    history: row.history,
    containsPersonalInfo: numberToFormBoolean(row.contains_personal_info),
    piiRetentionAware: numberToFormBoolean(row.pii_retention_aware),
    piiRetentionApplied: numberToFormBoolean(row.pii_retention_applied),
    piiRetentionPeriod: row.pii_retention_period,
    remarks: row.remarks,
  };
}

function formToPayload(form: GovernanceForm): Record<string, unknown> {
  return {
    accountId: form.accountId,
    accountName: form.accountName,
    phase: form.phase,
    bucketName: form.bucketName,
    ownerTeam: form.ownerTeam,
    purpose: form.purpose,
    history: form.history,
    containsPersonalInfo: formBooleanToPayload(form.containsPersonalInfo),
    piiRetentionAware: formBooleanToPayload(form.piiRetentionAware),
    piiRetentionApplied: formBooleanToPayload(form.piiRetentionApplied),
    piiRetentionPeriod: form.piiRetentionPeriod,
    remarks: form.remarks,
    updatedBy: 'awsops-ui',
  };
}

function numberToFormBoolean(value: number | null): NullableBoolean {
  if (value === null) return 'unknown';
  return value === 1 ? 'true' : 'false';
}

function formBooleanToPayload(value: NullableBoolean): boolean | null {
  if (value === 'unknown') return null;
  return value === 'true';
}

function nullableBooleanLabel(value: number | null): string {
  if (value === null) return '알 수 없음';
  return value === 1 ? '예' : '아니오';
}

function booleanLabel(value: string): string {
  if (value === 'unknown') return '알 수 없음';
  return value === 'true' ? '예' : '아니오';
}

function formatDate(value?: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR');
}

const selectClassName = 'min-w-32 max-w-full rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-200 focus:border-accent-cyan focus:ring-accent-cyan';
const secondaryButtonClassName = 'inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-navy-600 bg-navy-800 px-3 py-2 text-sm text-gray-300 hover:border-accent-cyan/50 hover:text-accent-cyan disabled:opacity-60 transition-colors';
const primaryButtonClassName = 'inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-3 py-2 text-sm text-accent-cyan hover:bg-accent-cyan/20 disabled:opacity-60 transition-colors';
