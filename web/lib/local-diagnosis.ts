import { closeSync, mkdirSync, openSync } from 'fs';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';
import { resolvePrivateSqlitePath } from './private-governance/sqlite-db';

export interface LocalDiagnosisJob {
  reportId: number;
  jobId: string;
  account: string;
  scope: string;
  tier: string;
  model: string;
  requestedBy: string;
}

export function startLocalDiagnosisJob(job: LocalDiagnosisJob): void {
  const root = process.cwd();
  const dbPath = resolvePrivateSqlitePath();
  const logPath = resolve(root, 'data/logs', `local-diagnosis-${job.reportId}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const stdout = openSync(logPath, 'a');
  const stderr = openSync(logPath, 'a');
  const child = spawn(
    process.env.PYTHON || 'python3',
    [
      'scripts/v2/workers/local_diagnosis_runner.py',
      '--db', dbPath,
      '--report-id', String(job.reportId),
      '--job-id', job.jobId,
      '--account', job.account,
      '--scope', job.scope,
      '--tier', job.tier,
      '--model', job.model,
      '--requested-by', job.requestedBy,
    ],
    {
      cwd: root,
      detached: true,
      env: { ...process.env, AWSOPS_PRIVATE_SQLITE_PATH: dbPath },
      stdio: ['ignore', stdout, stderr],
    },
  );
  child.unref();
  closeSync(stdout);
  closeSync(stderr);
}
