'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Header from '@/components/layout/Header';
import StatusBadge from '@/components/dashboard/StatusBadge';
import {
  AlertCircle,
  Building2,
  ClipboardCheck,
  Download,
  RefreshCw,
  ShieldAlert,
  Users,
  UserCheck,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

interface AuditRun {
  id: string;
  status: string;
  started_at: string;
  finished_at?: string | null;
  total_users: number;
  org_resolved_users: number;
  changed_users: number;
  risky_users: number;
  error_count: number;
  error_message: string;
}

interface Finding {
  id: string;
  run_id: string;
  display_name: string;
  severity: string;
  old_org_code: string;
  old_org_name: string;
  new_org_code: string;
  new_org_name: string;
  assignment_count: number;
  message: string;
  created_at: string;
}

interface AuditResponse {
  latestRun: AuditRun | null;
  runs: AuditRun[];
  findings: {
    rows: Finding[];
  };
}

const API_URL = '/awsops/api/identity-audit';

export default function IdentityAuditPage() {
  const [latestRun, setLatestRun] = useState<AuditRun | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Finding | null>(null);

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

  const fetchAudit = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchJson<AuditResponse>(API_URL);
      setLatestRun(data.latestRun ?? null);
      setFindings(data.findings?.rows ?? []);
    } catch (err) {
      setLatestRun(null);
      setFindings([]);
      setError(err instanceof Error ? err.message : 'Identity 감사 결과를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  const runAudit = async () => {
    setRunning(true);
    setError('');
    try {
      await fetchJson<{ ok?: boolean; runId?: string }>(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'run' }),
      });
      await fetchAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Identity 감사를 실행하지 못했습니다.');
    } finally {
      setRunning(false);
    }
  };

  const stats = useMemo(() => ({
    totalUsers: latestRun?.total_users ?? 0,
    orgResolvedUsers: latestRun?.org_resolved_users ?? 0,
    changedUsers: latestRun?.changed_users ?? 0,
    riskyUsers: latestRun?.risky_users ?? 0,
  }), [latestRun]);

  return (
    <div className="flex-1 overflow-auto">
      <Header
        title="Identity 감사"
        subtitle="부서 이동자 중 IAM Identity Center 권한이 남아 있는 사용자를 점검합니다"
        onRefresh={fetchAudit}
      />

      <main className="space-y-5 p-6">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red">
            <AlertCircle size={18} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <section className="rounded-lg border border-navy-600 bg-navy-800 px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-mono uppercase text-gray-500">Latest run</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-gray-200">
                  {latestRun ? formatDate(latestRun.finished_at || latestRun.started_at) : '-'}
                </span>
                {latestRun && <StatusBadge status={latestRun.status} />}
                {latestRun?.error_count ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-red/10 px-2 py-0.5 text-xs text-accent-red">
                    <AlertCircle size={12} />
                    {latestRun.error_count}
                  </span>
                ) : null}
              </div>
              {latestRun?.error_message && (
                <p className="mt-2 text-xs text-accent-red break-words">{latestRun.error_message}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={fetchAudit}
                disabled={loading || running}
                className="inline-flex min-w-[40px] items-center justify-center rounded-lg border border-navy-600 bg-navy-700 p-2 text-gray-400 transition-colors hover:border-accent-cyan/50 hover:text-accent-cyan disabled:opacity-60"
                title="새로고침"
              >
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
              <a
                href={`${API_URL}?action=export`}
                className="inline-flex min-w-[40px] items-center justify-center rounded-lg border border-navy-600 bg-navy-700 p-2 text-gray-400 transition-colors hover:border-accent-cyan/50 hover:text-accent-cyan"
                title="CSV 다운로드"
              >
                <Download size={16} />
              </a>
              <button
                onClick={runAudit}
                disabled={running || loading}
                className="inline-flex min-w-0 items-center justify-center gap-2 rounded-lg border border-accent-cyan/40 bg-accent-cyan/10 px-4 py-2 text-sm text-accent-cyan transition-colors hover:bg-accent-cyan/20 disabled:opacity-60"
              >
                <ClipboardCheck size={16} />
                <span className="truncate">{running ? '실행 중' : '감사 실행'}</span>
              </button>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="전체 사용자" value={stats.totalUsers} icon={Users} color="cyan" />
          <MetricCard label="조직 확인" value={stats.orgResolvedUsers} icon={UserCheck} color="green" />
          <MetricCard label="부서 변경" value={stats.changedUsers} icon={Building2} color="orange" />
          <MetricCard label="권한 잔존" value={stats.riskyUsers} icon={ShieldAlert} color="red" />
        </section>

        <section className="rounded-lg border border-navy-600 bg-navy-800 overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-navy-600 px-5 py-4">
            <h2 className="text-sm font-semibold text-white">감사 결과</h2>
            <span className="font-mono text-xs text-gray-500">{findings.length} rows</span>
          </div>

          {loading ? (
            <LoadingTable />
          ) : findings.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <ClipboardCheck size={32} className="mx-auto text-gray-600" />
              <p className="mt-3 text-sm font-medium text-gray-300">표시할 감사 결과가 없습니다</p>
              <p className="mt-1 text-sm text-gray-500">감사 실행 후 권한이 잔존한 사용자가 이 목록에 표시됩니다.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] table-fixed">
                <thead>
                  <tr className="bg-navy-700">
                    <TableHead className="w-[28%]">사용자</TableHead>
                    <TableHead className="w-[22%]">이전 조직</TableHead>
                    <TableHead className="w-[22%]">현재 조직</TableHead>
                    <TableHead className="w-[12%] text-right">권한 수</TableHead>
                    <TableHead className="w-[16%]">심각도</TableHead>
                  </tr>
                </thead>
                <tbody>
                  {findings.map((finding) => (
                    <tr
                      key={finding.id}
                      onClick={() => setSelected(finding)}
                      className="cursor-pointer border-b border-navy-600 transition-colors hover:bg-navy-700/70"
                    >
                      <TableCell>
                        <span className="block truncate font-medium text-gray-200">{finding.display_name || '-'}</span>
                        <span className="mt-1 block truncate font-mono text-xs text-gray-600">{finding.id}</span>
                      </TableCell>
                      <TableCell>
                        <OrgText code={finding.old_org_code} name={finding.old_org_name} />
                      </TableCell>
                      <TableCell>
                        <OrgText code={finding.new_org_code} name={finding.new_org_name} />
                      </TableCell>
                      <TableCell className="text-right font-mono text-white">
                        {formatNumber(finding.assignment_count)}
                      </TableCell>
                      <TableCell>
                        <SeverityBadge severity={finding.severity} />
                      </TableCell>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {selected && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/40">
          <button
            className="flex-1 cursor-default"
            aria-label="닫기"
            onClick={() => setSelected(null)}
          />
          <aside className="h-full w-full max-w-xl overflow-y-auto border-l border-navy-600 bg-navy-900 shadow-2xl">
            <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-navy-600 bg-navy-900 px-5 py-4">
              <div className="min-w-0">
                <p className="text-xs font-mono uppercase text-accent-cyan">Identity Audit</p>
                <h2 className="mt-1 truncate text-xl font-semibold text-white">{selected.display_name || '-'}</h2>
                <div className="mt-2">
                  <SeverityBadge severity={selected.severity} />
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-navy-700 hover:text-gray-200"
                title="닫기"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-5 px-5 py-5">
              <div className="rounded-lg border border-navy-600 bg-navy-800 px-4 py-3 text-sm text-gray-300">
                {selected.message || '-'}
              </div>

              <section className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <ReadOnly label="이전 조직" value={formatOrg(selected.old_org_code, selected.old_org_name)} />
                <ReadOnly label="현재 조직" value={formatOrg(selected.new_org_code, selected.new_org_name)} />
                <ReadOnly label="남은 권한 수" value={formatNumber(selected.assignment_count)} />
                <ReadOnly label="탐지 시각" value={formatDate(selected.created_at)} />
              </section>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

function MetricCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: LucideIcon;
  color: 'cyan' | 'green' | 'orange' | 'red';
}) {
  const colors = {
    cyan: 'bg-accent-cyan/10 text-accent-cyan',
    green: 'bg-accent-green/10 text-accent-green',
    orange: 'bg-accent-orange/10 text-accent-orange',
    red: 'bg-accent-red/10 text-accent-red',
  }[color];

  return (
    <div className="relative min-h-[116px] overflow-hidden rounded-lg border border-navy-600 bg-navy-800 p-5">
      <div className={`absolute right-4 top-4 rounded-lg p-2.5 ${colors}`}>
        <Icon size={20} />
      </div>
      <p className="pr-12 text-sm text-gray-400">{label}</p>
      <p className="mt-2 truncate pr-12 font-mono text-3xl font-bold text-white">{formatNumber(value)}</p>
    </div>
  );
}

function LoadingTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] table-fixed">
        <thead>
          <tr className="bg-navy-700">
            <TableHead className="w-[28%]">사용자</TableHead>
            <TableHead className="w-[22%]">이전 조직</TableHead>
            <TableHead className="w-[22%]">현재 조직</TableHead>
            <TableHead className="w-[12%] text-right">권한 수</TableHead>
            <TableHead className="w-[16%]">심각도</TableHead>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, index) => (
            <tr key={index} className="border-b border-navy-600">
              {Array.from({ length: 5 }).map((__, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3">
                  <div className="h-4 w-3/4 animate-pulse rounded bg-navy-700" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableHead({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <th className={`px-4 py-3 text-left text-xs font-mono font-semibold uppercase tracking-wider text-accent-cyan ${className}`}>
      {children}
    </th>
  );
}

function TableCell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <td className={`px-4 py-3 text-sm text-gray-300 ${className}`}>
      {children}
    </td>
  );
}

function OrgText({ code, name }: { code: string; name: string }) {
  return (
    <span className="block min-w-0">
      <span className="block truncate text-gray-200">{name || '-'}</span>
      <span className="mt-1 block truncate font-mono text-xs text-gray-600">{code || '-'}</span>
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const normalized = severity.toLowerCase();
  const className = normalized === 'high'
    ? 'border-accent-red/20 bg-accent-red/10 text-accent-red'
    : normalized === 'medium'
      ? 'border-accent-orange/20 bg-accent-orange/10 text-accent-orange'
      : 'border-gray-500/20 bg-gray-500/10 text-gray-400';

  return (
    <span className={`inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-xs font-medium uppercase ${className}`}>
      <span className="truncate">{severity || 'unknown'}</span>
    </span>
  );
}

function ReadOnly({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-navy-600 bg-navy-800 px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <div className="mt-1 break-words text-sm text-gray-200">{value || '-'}</div>
    </div>
  );
}

function formatOrg(code: string, name: string) {
  if (code && name) return `${name} (${code})`;
  return name || code || '-';
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(Number.isFinite(value) ? value : 0);
}
