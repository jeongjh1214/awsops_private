import { getPool, shouldUseLocalSqlitePool } from './db';
import type { ChatLang } from './chat-i18n';

interface InventoryRow {
  resource_id: string;
  region: string;
  account_id: string;
  data: Record<string, unknown> | string | null;
  captured_at: string | null;
}

const TYPE_ALIASES: Record<string, { label: string; patterns: RegExp[] }> = {
  ec2: {
    label: 'EC2',
    patterns: [/ec2/i, /인스턴스|instance/i],
  },
  s3: {
    label: 'S3',
    patterns: [/s3/i, /버킷|bucket/i],
  },
  rds: {
    label: 'RDS',
    patterns: [/rds|aurora/i, /db\s*인스턴스|database/i],
  },
  lambda: {
    label: 'Lambda',
    patterns: [/lambda|람다/i],
  },
  ebs_volume: {
    label: 'EBS Volume',
    patterns: [/ebs/i, /볼륨|volume/i],
  },
};

const INVENTORY_INTENT = /현황|목록|리스트|보여|알려|몇\s*개|count|list|inventory|resource/i;

export async function answerLocalInventoryPrompt(prompt: string, lang: ChatLang): Promise<string | null> {
  if (!shouldUseLocalSqlitePool()) return null;
  if (!INVENTORY_INTENT.test(prompt)) return null;

  const type = pickInventoryType(prompt);
  if (!type) return null;

  const pool = getPool();
  const result = await pool.query<InventoryRow>(
    `SELECT resource_id, region, account_id, data, captured_at
       FROM inventory_resources
      WHERE resource_type = $1
      ORDER BY captured_at DESC
      LIMIT $2 OFFSET $3`,
    [type, 500, 0],
  );
  return renderInventoryAnswer(type, result.rows, lang);
}

function pickInventoryType(prompt: string): string | null {
  for (const [type, spec] of Object.entries(TYPE_ALIASES)) {
    if (spec.patterns.some((pattern) => pattern.test(prompt))) return type;
  }
  return null;
}

function renderInventoryAnswer(type: string, rows: InventoryRow[], lang: ChatLang): string {
  if (lang !== 'ko') return renderEnglishInventoryAnswer(type, rows);

  const label = TYPE_ALIASES[type]?.label ?? type;
  if (rows.length === 0) {
    return [
      `SQLite 인벤토리에서 **${label} 리소스는 0개**로 조회됩니다.`,
      '',
      '먼저 Steampipe 동기화가 해당 타입까지 끝났는지 확인해 주세요.',
      '',
      '```bash',
      `bash scripts/18-sync-steampipe-to-sqlite.sh --types ${type}`,
      '```',
    ].join('\n');
  }

  const parsed = rows.map((row) => ({ ...row, data: parseData(row.data) }));
  const latest = latestCapturedAt(parsed);
  const stateKey = type === 'ec2' ? 'instance_state' : 'status';
  const byState = topCounts(parsed, (row) => stringValue(row.data[stateKey] ?? row.data.state ?? row.data.status));
  const byRegion = topCounts(parsed, (row) => stringValue(row.region));
  const byAccount = topCounts(parsed, (row) => stringValue(row.account_id));
  const byKind = type === 'ec2'
    ? topCounts(parsed, (row) => stringValue(row.data.instance_type))
    : [];
  const staleNote = latest ? freshnessNote(latest) : '';

  const lines = [
    `## ${label} 리소스 현황`,
    '',
    `현재 SQLite 인벤토리 기준으로 **${label} 리소스는 총 ${rows.length}개**입니다.`,
    latest ? `마지막 수집 시각은 \`${latest}\`입니다.${staleNote ? ` ${staleNote}` : ''}` : '',
    '',
    '### 한눈에 보기',
    renderOverviewBullets(type, parsed, byState, byRegion, byAccount, byKind),
    '',
    '### 분포',
    renderCountSection('상태별', byState),
    renderCountSection('리전별', byRegion),
    byAccount.length > 1 ? renderCountSection('계정별', byAccount) : '',
    byKind.length ? renderCountSection('인스턴스 타입별', byKind) : '',
    '',
    '### 주요 리소스',
    renderMarkdownTable(parsed.slice(0, 10).map((row) => ({
      Name: resourceName(row),
      ID: row.resource_id,
      State: stringValue(row.data[stateKey] ?? row.data.state ?? row.data.status),
      Type: stringValue(row.data.instance_type ?? row.data.engine ?? row.data.runtime),
      Region: row.region || '-',
      Account: row.account_id || '-',
    }))),
    '',
    '### 운영 체크포인트',
    renderOperationalChecks(type, parsed),
  ].filter(Boolean);

  return lines.join('\n');
}

function renderEnglishInventoryAnswer(type: string, rows: InventoryRow[]): string {
  const label = TYPE_ALIASES[type]?.label ?? type;
  if (rows.length === 0) return `SQLite inventory currently has **0 ${label} resources**. Run the Steampipe-to-SQLite sync for \`${type}\` first.`;
  const parsed = rows.map((row) => ({ ...row, data: parseData(row.data) }));
  return [
    `SQLite inventory has **${rows.length} ${label} resources**.`,
    latestCapturedAt(parsed) ? `Latest capture: \`${latestCapturedAt(parsed)}\`` : '',
    '',
    renderCountSection('By state', topCounts(parsed, (row) => stringValue(row.data.instance_state ?? row.data.state ?? row.data.status))),
    renderCountSection('By region', topCounts(parsed, (row) => stringValue(row.region))),
    '',
    renderMarkdownTable(parsed.slice(0, 10).map((row) => ({
      Name: resourceName(row),
      ID: row.resource_id,
      State: stringValue(row.data.instance_state ?? row.data.state ?? row.data.status),
      Type: stringValue(row.data.instance_type ?? row.data.engine ?? row.data.runtime),
      Region: row.region || '-',
      Account: row.account_id || '-',
    }))),
  ].filter(Boolean).join('\n');
}

function renderCountSection(title: string, counts: [string, number][]): string {
  if (!counts.length) return '';
  return [
    `**${title}**`,
    ...counts.slice(0, 8).map(([name, count]) => `- ${name}: ${count}`),
  ].join('\n');
}

function renderOverviewBullets(
  type: string,
  rows: (InventoryRow & { data: Record<string, unknown> })[],
  byState: [string, number][],
  byRegion: [string, number][],
  byAccount: [string, number][],
  byKind: [string, number][],
): string {
  const dominantState = byState[0];
  const dominantRegion = byRegion[0];
  const accountScope = byAccount.length > 1 ? `${byAccount.length}개 계정` : `계정 ${byAccount[0]?.[0] ?? '-'}`;
  const lines = [
    `- 범위: ${accountScope}, ${byRegion.length}개 리전`,
    dominantRegion ? `- 가장 많은 리전: ${dominantRegion[0]} (${dominantRegion[1]}개)` : '',
    dominantState ? `- 가장 많은 상태: ${dominantState[0]} (${dominantState[1]}개)` : '',
  ];

  if (type === 'ec2') {
    const running = countState(rows, 'running');
    const stopped = countState(rows, 'stopped');
    lines.push(`- 실행 중/중지: running ${running}개, stopped ${stopped}개`);
    if (byKind[0]) lines.push(`- 가장 많은 인스턴스 타입: ${byKind[0][0]} (${byKind[0][1]}개)`);
  }

  return lines.filter(Boolean).join('\n');
}

function renderOperationalChecks(type: string, rows: (InventoryRow & { data: Record<string, unknown> })[]): string {
  if (type === 'ec2') {
    const stopped = rows.filter((row) => stringValue(row.data.instance_state).toLowerCase() === 'stopped');
    const unnamed = rows.filter((row) => resourceName(row) === row.resource_id);
    return [
      stopped.length ? `- 중지된 EC2 ${stopped.length}개는 장기 미사용/정리 대상인지 확인해 볼 만합니다.` : '- 중지 상태 EC2는 현재 표본에서 보이지 않습니다.',
      unnamed.length ? `- Name 태그가 비어 보이는 EC2가 ${unnamed.length}개 있습니다. 소유자 식별을 위해 태그 보강을 권장합니다.` : '- 주요 EC2에는 식별 가능한 이름이 있습니다.',
      '- 비용/보안까지 이어서 보려면 “중지된 EC2 중 정리 후보 알려줘” 또는 “EC2 보안그룹 노출도 같이 봐줘”처럼 물어보면 됩니다.',
    ].join('\n');
  }

  if (type === 's3') {
    return [
      '- 공개 접근, 암호화, 로깅 여부는 S3 상세 인벤토리와 S3 개인정보 관리 메뉴에서 함께 확인하는 것이 좋습니다.',
      '- 개인정보 포함 가능성이 있는 버킷은 보존기간 인지/적용 여부까지 기록해 두는 흐름을 권장합니다.',
    ].join('\n');
  }

  return [
    '- 상태가 비정상인 항목과 태그/소유자 누락 항목을 우선 확인하는 것이 좋습니다.',
    '- 필요한 경우 리소스 타입별 상세 메뉴에서 필터를 걸어 원본 필드를 확인할 수 있습니다.',
  ].join('\n');
}

function renderMarkdownTable(rows: Record<string, string>[]): string {
  if (!rows.length) return '_표시할 항목이 없습니다._';
  const headers = Object.keys(rows[0]);
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' |')} |`,
    ...rows.map((row) => `| ${headers.map((key) => escapeCell(row[key])).join(' |')} |`),
  ].join('\n');
}

function topCounts<T>(rows: T[], getter: (row: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = getter(row) || '(none)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function parseData(value: InventoryRow['data']): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function latestCapturedAt(rows: InventoryRow[]): string {
  return rows.map((row) => row.captured_at).filter((value): value is string => !!value).sort().at(-1) ?? '';
}

function freshnessNote(value: string): string {
  const captured = new Date(value).getTime();
  if (!Number.isFinite(captured)) return '';
  const ageHours = Math.floor((Date.now() - captured) / 3_600_000);
  if (ageHours < 0 || ageHours < 24) return '';
  return `수집 후 약 ${Math.floor(ageHours / 24)}일이 지나 최신성이 낮을 수 있습니다.`;
}

function countState(rows: (InventoryRow & { data: Record<string, unknown> })[], state: string): number {
  return rows.filter((row) => stringValue(row.data.instance_state ?? row.data.state ?? row.data.status).toLowerCase() === state).length;
}

function resourceName(row: InventoryRow & { data: Record<string, unknown> }): string {
  return stringValue(row.data.name ?? row.data.Name ?? row.data.title ?? row.data.instance_id) || row.resource_id;
}

function stringValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
