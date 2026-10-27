/**
 * What the in-process scheduler runs, and when. Pure data (client-safe) so
 * tests and docs can read it; what each job does is in jobs.ts.
 *
 * Two kinds of work:
 *
 * - Platform-wide jobs below, each one slot at a time across every
 *   organization (the job's own code iterates organizations).
 * - The daily rollover, once per organization at the start of that
 *   organization's day (Settings → 组织 → 时区 / 新的一天从几点开始):
 *   builds its email queues and renews its Gmail watches.
 *
 * 改造：三个 LinkedIn 任务（run-outreach / search-queue / replay-webhooks）随
 * 频道一起删除；剩下的两个与渠道无关。企微、短信、外呼的发送引擎接入时，
 * 在这里加一项、在 jobs.ts 里加一个 case 即可。
 *
 * All times are UTC unless a job names a zone.
 */
import { dailyAt, everyMinutes, type Schedule } from "./slots";

export type PlatformJobName = "crm-auto-follow-ups" | "history-prune";

export type PlatformJob = {
  name: PlatformJobName;
  schedule: Schedule;
  /**
   * Run in-process. When false the job is only run by its endpoint (a click
   * or an external cron) exactly as before, without slot dedupe.
   */
  enabled: boolean;
  /** The HTTP route that also runs it, if any: its migration-mode block applies here too. */
  endpoint?: string;
  description: string;
};

export const PLATFORM_JOBS: readonly PlatformJob[] = [
  {
    // Each run sends at most one follow-up per sending account; the
    // per-account gap (Sending rules, default 30 min) does the spacing.
    name: "crm-auto-follow-ups",
    schedule: everyMinutes(5),
    enabled: true,
    description: "CRM 自动跟进：每轮每个发信账号最多发一封（序列里开了「自动发送跟进」的）",
  },
  {
    name: "history-prune",
    schedule: dailyAt("00:00", "UTC"),
    enabled: true,
    description: "清理历史任务记录与过期的调度占位",
  },
];

export function platformJob(name: PlatformJobName): PlatformJob {
  const job = PLATFORM_JOBS.find((j) => j.name === name);
  if (!job) throw new Error(`Unknown scheduled job ${name}`);
  return job;
}

export const ROLLOVER_JOB_PREFIX = "daily-rollover:";

export function rolloverJobName(organizationId: string): string {
  return `${ROLLOVER_JOB_PREFIX}${organizationId}`;
}

/** How long claim rows are kept. */
export const CLAIM_RETENTION_DAYS = 30;
