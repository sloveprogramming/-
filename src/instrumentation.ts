// Next.js calls register() exactly once when the server process boots.
// Starts the background loops: the outreach send tick (single-instance, see
// its internalScheduler.ts), the scheduled jobs
// (src/lib/scheduler/internalScheduler.ts: each organization's daily rollover
// at its own new-day time, CRM auto follow-ups, history pruning), the
// enrichment grid worker and the CRM worker. Those run on fixed clock slots
// claimed in the database, so restarts do not shift them and overlapping
// instances run each slot once.
//
// 改造：WhatsApp 的消息活动发送器与 LinkedIn 的发送引擎随频道一并删除。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // skip edge runtime invocations

  // The public demo is read-only fictional data: nothing may send, sync,
  // enrich or call a model, so none of the loops below start
  // (src/lib/demo/mode.ts). Only its clock runs, keeping the data current.
  const { isDemoMode } = await import("./lib/demo/mode");
  if (isDemoMode()) {
    const { startDemoClock } = await import("./lib/demo/clock");
    startDemoClock();
    return;
  }

  // Outreach remains production-only: it is not backed by a distributed
  // claim lock and duplicate dev hot-reload loops could double-send messages.
  if (process.env.NODE_ENV === "production") {
    const { startInternalOutreachScheduler } = await import("./lib/outreach/internalScheduler");
    startInternalOutreachScheduler();
  }

  // Scheduled jobs; INTERNAL_SCHEDULER=false leaves them to an external cron.
  const { internalSchedulerEnabled } = await import("./lib/scheduler/config");
  if (internalSchedulerEnabled()) {
    const { startInternalScheduler } = await import("./lib/scheduler/internalScheduler");
    startInternalScheduler();
  }

  // Enrichment cell worker. Unlike the outreach tick above, this one claims
  // work with SKIP LOCKED, so it is safe in development too. Keeping it active
  // here is essential: manual runs otherwise remain queued forever in next dev.
  const { startGridWorker } = await import("./lib/grid/worker");
  startGridWorker();

  // CRM only claims durable AI classification/drafting jobs for registered
  // handlers. It has no sending job kind, and SKIP LOCKED keeps this safe when
  // multiple app instances overlap during a deployment.
  const { registerDefaultCrmJobHandlers } = await import("./lib/crm/handlers");
  registerDefaultCrmJobHandlers();
  const { startCrmWorker } = await import("./lib/crm/worker");
  startCrmWorker();
}
