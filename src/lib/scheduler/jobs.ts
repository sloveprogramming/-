import "server-only";

import { pruneJobHistory } from "@/jobs/resetDailyLimits";
import { runCrmAutoFollowUps } from "@/lib/crm/autoFollowUps";
import { pruneClaims } from "./claims";
import type { PlatformJobName } from "./schedules";

/**
 * What each platform-wide scheduled job does, used by the in-process
 * scheduler and by the cron endpoints, so the two cannot drift apart.
 *
 * 改造：原来这里有三个 LinkedIn 任务（发邀请、搜索队列、重放 webhook）和一个
 * 基于 JobRun 的全局互斥锁。LinkedIn 整套删除后只剩 CRM 自动跟进与历史清理；
 * 将来接入企微/短信的发送引擎时，按同样的形状在这里注册即可。
 */
export type StartedJob = {
  /** What the endpoint answers. */
  body: Record<string, unknown>;
  /** Settles when the work ends (never rejects): null on success, else the error. */
  done: Promise<string | null>;
};

const finished: Promise<string | null> = Promise.resolve(null);

export async function startPlatformJob(name: PlatformJobName): Promise<StartedJob> {
  switch (name) {
    case "crm-auto-follow-ups": {
      const summary = await runCrmAutoFollowUps();
      return { body: { ok: true, summary }, done: finished };
    }
    case "history-prune": {
      await pruneJobHistory();
      const prunedClaims = await pruneClaims();
      return { body: { ok: true, prunedClaims }, done: finished };
    }
  }
}
