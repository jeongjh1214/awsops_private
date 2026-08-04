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

  const lines = [
    `SQLite 인벤토리 기준 **${label} 리소스는 총 ${rows.length}개**입니다.`,
    latest ? `최신 수집 시각: \`${latest}\`` : '',
    '',
    renderCountSection('상태별', byState),
    renderCountSection('리전별', byRegion),
    byAccount.length > 1 ? renderCountSection('계정별', byAccount) : '',
    byKind.length ? renderCountSection('인스턴스 타입별', byKind) : '',
    '',
    '상위 항목:',
    '',
    renderMarkdownTable(parsed.slice(0, 10).map((row) => ({
      Name: resourceName(row),
      ID: row.resource_id,
      State: stringValue(row.data[stateKey] ?? row.data.state ?? row.data.status),
      Type: stringValue(row.data.instance_type ?? row.data.engine ?? row.data.runtime),
      Region: row.region || '-',
      Account: row.account_id || '-',
    }))),
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
    `${title}:`,
    ...counts.slice(0, 8).map(([name, count]) => `- ${name}: ${count}`),
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
