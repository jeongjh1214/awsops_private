import { runIdentityAudit } from './audit-runner';
import { resolveIdentityAuditConfig } from './config';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TUESDAY = 2;
const TEN_AM = 10;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastTriggeredKstHourKey: string | null = null;

export function startIdentityAuditScheduler(): void {
  if (isNextBuildPhase()) return;
  if (schedulerTimer) return;

  const check = async () => {
    try {
      const now = new Date();
      if (!isTuesdayTenKst(now)) return;

      const hourKey = toKstHourKey(now);
      if (hourKey === lastTriggeredKstHourKey) return;

      const config = resolveIdentityAuditConfig();
      if (!config.enabled) return;

      lastTriggeredKstHourKey = hourKey;
      await runIdentityAudit();
    } catch (error) {
      console.error('[Identity Audit Scheduler] Check failed:', error);
    }
  };

  schedulerTimer = setInterval(() => {
    void check();
  }, CHECK_INTERVAL_MS);
  (schedulerTimer as { unref?: () => void }).unref?.();
}

export function stopIdentityAuditScheduler(): void {
  if (!schedulerTimer) return;

  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

export function isTuesdayTenKst(date: Date = new Date()): boolean {
  const kstDate = toKstDate(date);
  return kstDate.getUTCDay() === TUESDAY && kstDate.getUTCHours() === TEN_AM;
}

function toKstHourKey(date: Date): string {
  return toKstDate(date).toISOString().slice(0, 13);
}

function toKstDate(date: Date): Date {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === 'phase-production-build';
}
