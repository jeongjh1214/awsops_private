import { Pool } from 'pg';
import { Signer } from '@aws-sdk/rds-signer';
import { getPrivateRuntimeConfig } from './private-runtime-config';
import { createLocalSqlitePool, type PoolLike } from './local-sqlite-pool';

let pool: PoolLike | null = null;
let warnedLocalSqlitePool = false;

// Single shared pg Pool for all API routes (Aurora PostgreSQL). Authenticates via RDS IAM DB auth
// (rds-db:connect on the task role) as the dedicated `awsops_web` role, not the Aurora master
// secret — mirrors steampipe.tf's steampipe_reader pattern. The master secret is RDS-managed and
// auto-rotates every 7 days; a long-running task that only reads a valueFrom secret once at
// container start would be left holding a stale password after the next rotation. `password` as a
// function is called by pg per new physical connection, so the signed token is always fresh
// (15-min validity, signed locally — no network call).
export function getPool(): PoolLike {
  if (!pool) {
    if (shouldUseLocalSqlitePool()) {
      if (!warnedLocalSqlitePool) {
        console.warn('[db] AURORA_ENDPOINT is not set; using local SQLite DB pool');
        warnedLocalSqlitePool = true;
      }
      pool = createLocalSqlitePool();
      return pool;
    }

    if (process.env.DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 3,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
      });
      return pool;
    }

    const signer = new Signer({
      hostname: process.env.AURORA_ENDPOINT!,
      port: 5432,
      username: process.env.AURORA_USER || 'awsops_web',
      region: process.env.AWS_REGION || 'ap-northeast-2',
    });
    pool = new Pool({
      host: process.env.AURORA_ENDPOINT,
      port: 5432,
      database: process.env.AURORA_DATABASE || 'awsops',
      user: process.env.AURORA_USER || 'awsops_web',
      password: () => signer.getAuthToken(),
      ssl: { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
  }
  return pool;
}

function shouldUseLocalSqlitePool(): boolean {
  if (process.env.AURORA_ENDPOINT || process.env.DATABASE_URL) return false;
  if (process.env.AWSOPS_LOCAL_DB_PROVIDER === 'sqlite') return true;
  if (process.env.AWSOPS_LOCAL_DB_PROVIDER === 'aurora') return false;
  return getPrivateRuntimeConfig().activeEnvironment === 'local';
}
