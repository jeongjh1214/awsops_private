'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Search, ShieldCheck, Wand2 } from 'lucide-react';
import Badge from '@/components/ui/Badge';
import Button from '@/components/ui/Button';
import Card from '@/components/ui/Card';
import DataTable from '@/components/ui/DataTable';
import Input from '@/components/ui/Input';
import PageHeader from '@/components/ui/PageHeader';
import StatTile from '@/components/ui/StatTile';

type NullableBoolean = boolean | null;

interface S3GovernanceRow {
  stableKey: string;
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
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
  assetRegion: string | null;
  assetCapturedAt: string | null;
  active: boolean;
}

interface S3GovernanceEventRow {
  id: string;
  eventType: string;
  eventSource: string;
  summary: string;
  createdBy: string;
  createdAt: string;
}

interface S3GovernanceDetail extends S3GovernanceRow {
  events: S3GovernanceEventRow[];
}

interface ListResponse {
  rows: S3GovernanceRow[];
  total: number;
}

const columns = [
  { key: 'bucketName', label: 'Bucket' },
  { key: 'accountName', label: 'Account' },
  { key: 'phase', label: 'Phase' },
  { key: 'ownerTeam', label: '담당조직' },
  { key: 'containsPersonalInfoView', label: '개인정보' },
  { key: 'retentionView', label: '유효기간 적용' },
  { key: 'activeView', label: '상태' },
  { key: 'updatedAtView', label: '수정일' },
];

const emptyForm = {
  accountName: '',
  phase: '',
  ownerTeam: '',
  purpose: '',
  history: '',
  containsPersonalInfo: 'unknown',
  piiRetentionAware: 'unknown',
  piiRetentionApplied: 'unknown',
  piiRetentionPeriod: '',
  remarks: '',
};

type FormState = typeof emptyForm;

export default function S3GovernancePage() {
  const [rows, setRows] = useState<S3GovernanceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('true');
  const [containsPersonalInfo, setContainsPersonalInfo] = useState('');
  const [retentionApplied, setRetentionApplied] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<S3GovernanceDetail | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: '1000' });
    if (query.trim()) p.set('q', query.trim());
    if (active) p.set('active', active);
    if (containsPersonalInfo) p.set('containsPersonalInfo', containsPersonalInfo);
    if (retentionApplied) p.set('piiRetentionApplied', retentionApplied);
    return p;
  }, [active, containsPersonalInfo, query, retentionApplied]);

  const load = useCallback(async () => {
    setError('');
    setLoading(true);
    try {
      const res = await fetch(`/api/private-governance/s3?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      setRows(Array.isArray(data.rows) ? data.rows : []);
      setTotal(Number((data as ListResponse).total ?? 0));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => ({
    total,
    personal: rows.filter((row) => row.containsPersonalInfo === true).length,
    retentionMissing: rows.filter((row) => row.containsPersonalInfo === true && row.piiRetentionApplied !== true).length,
    inactive: rows.filter((row) => !row.active).length,
  }), [rows, total]);

  const tableRows = useMemo(() => rows.map((row) => ({
    ...row,
    accountName: row.accountName || row.accountId,
    containsPersonalInfoView: <TriBadge value={row.containsPersonalInfo} />,
    retentionView: <TriBadge value={row.piiRetentionApplied} />,
    activeView: <Badge tone={row.active ? 'positive' : 'negative'} variant="soft">{row.active ? 'active' : 'missing'}</Badge>,
    updatedAtView: formatDate(row.updatedAt),
    original: row,
  })), [rows]);

  const openDetail = async (row: S3GovernanceRow) => {
    setBusy(row.stableKey);
    setMessage('');
    setError('');
    try {
      const res = await fetch(`/api/private-governance/s3/${encodeURIComponent(row.stableKey)}`);
      const detail = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(detail.message || `HTTP ${res.status}`);
      setSelected(detail);
      setForm(rowToForm(detail));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const seedFromInventory = async () => {
    setBusy('seed');
    setMessage('');
    setError('');
    try {
      const res = await fetch('/api/private-governance/s3?action=seed-from-inventory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updatedBy: 'awsops-ui' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      const s = data.summary ?? {};
      setMessage(`인벤토리 반영 완료: 신규 ${s.created ?? 0}개, 기존 ${s.skipped ?? 0}개`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!selected) return;
    setBusy('save');
    setMessage('');
    setError('');
    try {
      const res = await fetch(`/api/private-governance/s3/${encodeURIComponent(selected.stableKey)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...form,
          containsPersonalInfo: parseTri(form.containsPersonalInfo),
          piiRetentionAware: parseTri(form.piiRetentionAware),
          piiRetentionApplied: parseTri(form.piiRetentionApplied),
          updatedBy: 'awsops-ui',
        }),
      });
      const detail = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(detail.message || `HTTP ${res.status}`);
      setSelected(detail);
      setForm(rowToForm(detail));
      setMessage('저장 완료');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const exportHref = `/api/private-governance/s3?action=export&${params.toString()}`;

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <PageHeader
        title="S3 개인정보 관리"
        subtitle="S3 버킷별 개인정보 여부, 보존기간 인지·적용 상태, 담당조직을 관리합니다."
        right={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={load} disabled={loading || !!busy}>
              <RefreshCw size={14} /> 새로고침
            </Button>
            <Button variant="secondary" size="sm" onClick={seedFromInventory} disabled={!!busy}>
              <Wand2 size={14} /> 인벤토리 반영
            </Button>
            <a
              href={exportHref}
              className="inline-flex h-[30px] items-center justify-center gap-1.5 rounded-md border border-ink-100 bg-card px-3 text-[12px] font-medium text-ink-800 hover:border-brand-action hover:bg-brand-action hover:text-white"
            >
              <Download size={14} /> CSV
            </a>
          </div>
        }
      />

      <main className="grid flex-1 grid-cols-1 gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="관리 대상" value={stats.total} variant="accent" icon={<ShieldCheck size={16} />} />
            <StatTile label="개인정보 포함" value={stats.personal} variant={stats.personal ? 'warn' : 'default'} icon={<ShieldCheck size={16} />} />
            <StatTile label="유효기간 미적용" value={stats.retentionMissing} variant={stats.retentionMissing ? 'danger' : 'default'} icon={<ShieldCheck size={16} />} />
            <StatTile label="인벤토리 미존재" value={stats.inactive} variant={stats.inactive ? 'warn' : 'default'} icon={<ShieldCheck size={16} />} />
          </div>

          <Card className="overflow-visible" padded={false}>
            <div className="flex flex-col gap-3 border-b border-ink-100 p-3 lg:flex-row lg:items-center">
              <div className="min-w-[220px] flex-1">
                <Input
                  icon={<Search size={15} />}
                  inputSize="sm"
                  placeholder="버킷, 계정, 담당조직, 용도 검색"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Select value={active} onChange={setActive} label="상태" options={[
                ['', '전체'],
                ['true', 'active'],
                ['false', 'missing'],
              ]} />
              <Select value={containsPersonalInfo} onChange={setContainsPersonalInfo} label="개인정보" options={triOptions(true)} />
              <Select value={retentionApplied} onChange={setRetentionApplied} label="유효기간 적용" options={triOptions(true)} />
            </div>
            {loading ? (
              <div className="p-8 text-center text-[13px] text-ink-400">로딩 중...</div>
            ) : (
              <DataTable
                columns={columns}
                rows={tableRows}
                cardTitleKey="bucketName"
                mobileColumns={['accountName', 'ownerTeam', 'containsPersonalInfoView', 'retentionView']}
                onRowClick={(row) => openDetail(row.original as S3GovernanceRow)}
              />
            )}
          </Card>
        </section>

        <aside className="min-w-0">
          <EditorPanel
            selected={selected}
            form={form}
            setForm={setForm}
            saving={busy === 'save'}
            onSave={save}
            onClose={() => setSelected(null)}
          />
        </aside>
      </main>

      {(message || error || busy) && (
        <div className="fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border border-ink-100 bg-card px-3 py-2 text-[12px] text-ink-700 shadow-pop">
          {busy && busy !== 'save' ? '처리 중...' : error ? <span className="text-negative-600">{error}</span> : message}
        </div>
      )}
    </div>
  );
}

function EditorPanel({
  selected,
  form,
  setForm,
  saving,
  onSave,
  onClose,
}: {
  selected: S3GovernanceDetail | null;
  form: FormState;
  setForm: (next: FormState) => void;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  if (!selected) {
    return (
      <Card className="sticky top-6">
        <div className="py-12 text-center text-[13px] text-ink-400">버킷을 선택하세요.</div>
      </Card>
    );
  }

  const update = (key: keyof FormState, value: string) => setForm({ ...form, [key]: value });

  return (
    <Card className="sticky top-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-[13px] font-semibold text-ink-800" title={selected.bucketName}>{selected.bucketName}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={selected.active ? 'positive' : 'negative'} variant="soft">{selected.active ? 'active' : 'missing'}</Badge>
            <Badge tone="neutral" variant="soft" mono>{selected.accountId}</Badge>
          </div>
        </div>
        <button className="rounded-md px-2 py-1 text-[12px] text-ink-500 hover:bg-ink-50" onClick={onClose}>닫기</button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3">
        <Field label="Account name" value={form.accountName} onChange={(v) => update('accountName', v)} />
        <Field label="Phase" value={form.phase} onChange={(v) => update('phase', v)} />
        <Field label="담당조직" value={form.ownerTeam} onChange={(v) => update('ownerTeam', v)} />
        <Field label="용도" value={form.purpose} onChange={(v) => update('purpose', v)} />
        <TextArea label="이력" value={form.history} onChange={(v) => update('history', v)} />
        <Select value={form.containsPersonalInfo} onChange={(v) => update('containsPersonalInfo', v)} label="개인정보 유무" options={triOptions(false)} wide />
        <Select value={form.piiRetentionAware} onChange={(v) => update('piiRetentionAware', v)} label="유효기간 인지" options={triOptions(false)} wide />
        <Select value={form.piiRetentionApplied} onChange={(v) => update('piiRetentionApplied', v)} label="유효기간 적용" options={triOptions(false)} wide />
        <Field label="적용 데이터 유효기간" value={form.piiRetentionPeriod} onChange={(v) => update('piiRetentionPeriod', v)} />
        <TextArea label="비고" value={form.remarks} onChange={(v) => update('remarks', v)} />
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="primary" size="sm" onClick={onSave} disabled={saving}>{saving ? '저장 중...' : '저장'}</Button>
      </div>

      {selected.events.length > 0 && (
        <div className="mt-5 border-t border-ink-100 pt-4">
          <div className="mb-2 text-[12px] font-semibold text-ink-700">변경 이력</div>
          <div className="space-y-2">
            {selected.events.slice(0, 5).map((event) => (
              <div key={event.id} className="rounded-md border border-ink-100 p-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge tone="brand" variant="soft" mono>{event.eventType}</Badge>
                  <span className="text-[10px] text-ink-400">{formatDate(event.createdAt)}</span>
                </div>
                <div className="mt-1 text-[12px] text-ink-600">{event.summary}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium text-ink-500">{label}</span>
      <input
        className="h-[32px] rounded-md border border-ink-100 bg-card px-2 text-[13px] text-ink-800 outline-none focus:border-brand-500 focus:shadow-focus"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid gap-1">
      <span className="text-[11px] font-medium text-ink-500">{label}</span>
      <textarea
        className="min-h-[68px] resize-y rounded-md border border-ink-100 bg-card px-2 py-1.5 text-[13px] text-ink-800 outline-none focus:border-brand-500 focus:shadow-focus"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  wide = false,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
  wide?: boolean;
}) {
  return (
    <label className={wide ? 'grid gap-1' : 'grid min-w-[132px] gap-1'}>
      <span className="text-[11px] font-medium text-ink-500">{label}</span>
      <select
        className="h-[30px] rounded-md border border-ink-100 bg-card px-2 text-[12px] text-ink-800 outline-none focus:border-brand-500 focus:shadow-focus"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
      </select>
    </label>
  );
}

function TriBadge({ value }: { value: NullableBoolean }) {
  if (value === true) return <Badge tone="positive" variant="soft">Y</Badge>;
  if (value === false) return <Badge tone="neutral" variant="soft">N</Badge>;
  return <Badge tone="negative" variant="soft">미확인</Badge>;
}

function triOptions(includeAll: boolean): [string, string][] {
  return [
    ...(includeAll ? [['', '전체'] as [string, string]] : []),
    ['true', 'Y'],
    ['false', 'N'],
    ['unknown', '미확인'],
  ];
}

function parseTri(value: string): NullableBoolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function formatTri(value: NullableBoolean): string {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return 'unknown';
}

function rowToForm(row: S3GovernanceRow): FormState {
  return {
    accountName: row.accountName ?? '',
    phase: row.phase ?? '',
    ownerTeam: row.ownerTeam ?? '',
    purpose: row.purpose ?? '',
    history: row.history ?? '',
    containsPersonalInfo: formatTri(row.containsPersonalInfo),
    piiRetentionAware: formatTri(row.piiRetentionAware),
    piiRetentionApplied: formatTri(row.piiRetentionApplied),
    piiRetentionPeriod: row.piiRetentionPeriod ?? '',
    remarks: row.remarks ?? '',
  };
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
