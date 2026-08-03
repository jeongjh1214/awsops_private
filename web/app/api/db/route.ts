import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!process.env.AURORA_ENDPOINT && !process.env.DATABASE_URL) {
      const r = await getPool().query(
        "SELECT count(*)::int AS n FROM inventory_resources",
      );
      return NextResponse.json({
        status: 'ok',
        provider: 'sqlite',
        inventory_resources: Number(r.rows[0]?.n ?? 0),
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
