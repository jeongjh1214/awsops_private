import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { resolvePrivateSqlitePath } from '@/lib/private-governance/sqlite-db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!process.env.AURORA_ENDPOINT && !process.env.DATABASE_URL) {
      const pool = getPool();
      const r = await pool.query(
        "SELECT count(*)::int AS n FROM inventory_resources",
      );
      const byType = await pool.query(
        "SELECT resource_type, count(*)::int AS n FROM inventory_resources GROUP BY resource_type ORDER BY resource_type",
      );
      const syncRuns = await pool.query(
        "SELECT resource_type, status, started_at, finished_at, row_count, error FROM inventory_sync_runs ORDER BY resource_type",
      );
      return NextResponse.json({
        status: 'ok',
        provider: 'sqlite',
        sqlite_path: resolvePrivateSqlitePath(),
        inventory_resources: Number(r.rows[0]?.n ?? 0),
        by_type: byType.rows,
        sync_runs: syncRuns.rows,
      });
    }

    const r = await getPool().query(
      "SELECT count(*)::int AS public_tables FROM pg_tables WHERE schemaname = 'public'",
    );
    return NextResponse.json({
      status: 'ok',
      database: process.env.AURORA_DATABASE || 'awsops',
      public_tables: r.rows[0].public_tables,
    });
  } catch (e) {
    return NextResponse.json(
      { status: 'error', message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
