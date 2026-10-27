import "server-only";

import { serializeError } from "@/lib/errors";
import { migrationMutationBlockReason } from "@/lib/migration/controls";
import { claimSlot, finishSlot, lastStarts } from "./claims";
import { organizationDays, runDailyRollover } from "./dailyRollover";
import { startPlatformJob } from "./jobs";
import { PLATFORM_JOBS, rolloverJobName, type PlatformJob } from "./schedules";
import { describeSchedule, latestDueSlot } from "./slots";

/**
 * The scheduled jobs, run inside the app (replacing the cron container):
 * the platform jobs in schedules.ts and each organization's daily rollover
 * (dailyRollover.ts). Started once from instrumentation.ts in production;
 * INTERNAL_SCHEDULER=false turns it off.
 *
 * Every TICK_MS it works out each job's latest due slot (slots.ts) and tries
 * to claim it in scheduled_job_runs (claims.ts); only the claimer runs it. So
 * a slot runs once across restarts, overlapping instances during a deploy,
 * and external cron calls to the same jobs' endpoints. After downtime only
 * the latest missed slot runs. Platform jobs run concurrently with each
 * other, but a job never overlaps itself in this process: while it runs its
 * new slots wait, and the latest one is claimed when it finishes. Rollovers
 * run one organization at a time.
 *
 * A job with no recorded run at all (the first start after this was
 * deployed, or a brand-new organization) does not run a slot that began
 * before this process started: on an install that used to run these from an
 * external cron, today's daily work has already been done by it, and rerunning
 * a LinkedIn daily reset mid-day would grant a second day's allowance. Its
 * first run is its next slot.
 *
 * Without the scheduled_job_runs table nothing runs (one loud warning): with
 * no claims it could not tell a restart from a new slot, nor itself from an
 * external cron, and would repeat daily resets. It starts working within a
 * tick of the migration being applied, no restart needed.
 */

const TICK_MS = 30_000;

let started = false;
let ticking = false;
let rolloverRunning = false;
const bootedAt = Date.now();
/** Each job's last slot that is settled for this process: claimed here, taken elsewhere, or skipped. */
const handled = new Map<string, number>();
const running = new Set<string>();
/** When each job last started, as recorded when this process first read it; null/undefined until read. */
let history: Map<string, Date> | null | undefined;

/** True when `slot` of `job` still needs a claim attempt. */
function due(job: string, slotMs: number): boolean {
  if (handled.get(job) === slotMs) return false;
  if (!handled.has(job) && !history?.has(job) && slotMs < bootedAt) {
    handled.set(job, slotMs);
    console.log(`[scheduler] ${job}: no earlier run recorded; first run at its next slot (not ${new Date(slotMs).toISOString()})`);
    return false;
  }
  return true;
}

async function execute(job: string, slot: Date, fn: () => Promise<{ summary: string; error: string | null }>, label = job) {
  const t0 = Date.now();
  let outcome: { summary: string; error: string | null };
  try {
    outcome = await fn();
  } catch (error) {
    outcome = { summary: "", error: serializeError(error) };
  }
  await finishSlot(job, slot, outcome.error);
  const took = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const line = `[scheduler] ${label} @ ${slot.toISOString()} ${outcome.error ? "FAILED" : "ok"} in ${took}${outcome.summary ? ` — ${outcome.summary}` : ""}`;
  if (outcome.error) console.error(`${line}: ${outcome.error}`);
  else console.log(line);
}

async function runPlatform(job: PlatformJob): Promise<{ summary: string; error: string | null }> {
  const { body, done } = await startPlatformJob(job.name);
  const error = await done;
  const summary = Object.entries(body)
    .filter(([key, value]) => key !== "ok" && value !== null && typeof value !== "object")
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
  return { summary, error };
}

async function considerPlatformJob(job: PlatformJob, now: Date) {
  if (running.has(job.name)) return;
  const slot = latestDueSlot(job.schedule, now);
  if (!due(job.name, slot.getTime())) return;
  const claim = await claimSlot(job.name, slot);
  if (claim === "missing-table") {
    history = undefined;
    return;
  }
  handled.set(job.name, slot.getTime());
  if (claim === "taken") return;

  // Same as the proxy refusing the endpoint to an external cron.
  const blocked = job.endpoint ? migrationMutationBlockReason(job.endpoint, "POST") : null;
  if (blocked) {
    await finishSlot(job.name, slot, `not run: ${blocked}`);
    console.warn(`[scheduler] ${job.name} @ ${slot.toISOString()} not run: ${blocked}`);
    return;
  }

  running.add(job.name);
  void execute(job.name, slot, () => runPlatform(job)).finally(() => running.delete(job.name));
}

async function rolloverPass(now: Date) {
  rolloverRunning = true;
  try {
    for (const day of await organizationDays(now)) {
      const job = rolloverJobName(day.organizationId);
      if (!due(job, day.slot.getTime())) continue;
      const claim = await claimSlot(job, day.slot);
      if (claim === "missing-table") {
        history = undefined;
        return;
      }
      handled.set(job, day.slot.getTime());
      if (claim === "taken") continue;
      await execute(job, day.slot, () => runDailyRollover(day.organizationId), `${job} (${day.dayStartsAt} ${day.timeZone})`);
    }
  } catch (error) {
    console.error("[scheduler] daily rollover pass failed:", error);
  } finally {
    rolloverRunning = false;
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    if (!history) {
      history = await lastStarts(PLATFORM_JOBS.map((job) => job.name), true);
      if (!history) return;
    }
    for (const job of PLATFORM_JOBS) {
      if (!job.enabled) continue;
      try {
        await considerPlatformJob(job, now);
      } catch (error) {
        console.error(`[scheduler] ${job.name}: could not claim its slot:`, error);
      }
    }
    if (!rolloverRunning) void rolloverPass(now);
  } catch (error) {
    console.error("[scheduler] tick failed:", error);
  } finally {
    ticking = false;
  }
}

/** Starts the scheduler. Idempotent; only the first call has any effect. */
export function startInternalScheduler() {
  if (started) return;
  started = true;
  const jobs = PLATFORM_JOBS.filter((job) => job.enabled).map((job) => `${job.name} (${describeSchedule(job.schedule)})`);
  console.log(`[scheduler] starting — ${jobs.join(", ")}, daily rollover per organization; tick every ${TICK_MS / 1000}s`);
  setInterval(() => void tick(), TICK_MS).unref();
  setTimeout(() => void tick(), 10_000).unref();
}
