import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { serializeError } from "@/lib/errors";
import { claimSlot, finishSlot } from "./claims";
import { internalSchedulerEnabled } from "./config";
import { rolloverStatus } from "./dailyRollover";
import { startPlatformJob } from "./jobs";
import { platformJob, type PlatformJobName } from "./schedules";
import { latestDueSlot } from "./slots";

/**
 * The job endpoints, when called with the cron secret (an external cron, not
 * a signed-in member running their own organization), share the in-process
 * scheduler's claims, so a cron and the scheduler reaching the same slot run
 * it once. With the scheduler off (INTERNAL_SCHEDULER=false, or not
 * production) they behave exactly as before. `?force=1` skips the dedupe,
 * for a deliberate manual re-run.
 */

function forced(request: NextRequest): boolean {
  const value = request.nextUrl.searchParams.get("force")?.toLowerCase();
  return value === "1" || value === "true";
}

/** Run a platform job for the cron caller, deduped against its current slot. */
export async function runPlatformJobForCron(name: PlatformJobName, request: NextRequest): Promise<NextResponse> {
  const job = platformJob(name);
  if (!job.enabled || !internalSchedulerEnabled() || forced(request)) {
    return NextResponse.json((await startPlatformJob(name)).body);
  }

  const slot = latestDueSlot(job.schedule, new Date());
  const claim = await claimSlot(name, slot);
  if (claim === "taken") {
    return NextResponse.json({ ok: true, skipped: `already ran for slot ${slot.toISOString()}`, slot: slot.toISOString() });
  }
  if (claim === "missing-table") return NextResponse.json((await startPlatformJob(name)).body);

  let started;
  try {
    started = await startPlatformJob(name);
  } catch (error) {
    await finishSlot(name, slot, serializeError(error));
    throw error;
  }
  void started.done.then((error) => finishSlot(name, slot, error));
  return NextResponse.json(started.body);
}

/**
 * For the daily endpoints called by the cron: the organizations to serve.
 * `organizationIds` undefined means every organization (no dedupe); otherwise
 * only those still awaiting today's rollover, with the skipped ones in
 * `alreadyRolledOver` for the response.
 */
export async function cronOrganizationFilter(request: NextRequest): Promise<{ organizationIds?: string[]; alreadyRolledOver?: string[] }> {
  if (!internalSchedulerEnabled() || forced(request)) return {};
  const status = await rolloverStatus();
  if (!status) return {};
  return { organizationIds: status.awaiting, alreadyRolledOver: status.rolledOver };
}
