import "server-only";

import { runCrmAutoFollowUps } from "@/lib/crm/autoFollowUps";
import { runImapInboxSync } from "@/lib/outreach/imapSync";
import { pruneClaims } from "./claims";
import type { PlatformJobName } from "./schedules";

/**
 * What each platform-wide scheduled job does, used by the in-process
 * scheduler and by the cron endpoints, so the two cannot drift apart.
 *
 * 改造：原来这里有三个 LinkedIn 任务（发邀请、搜索队列、重放 webhook）和一个
 * 基于 JobRun 的全局互斥锁。LinkedIn 整套删除后剩 CRM 自动跟进、历史清理，
 * 以及企业邮箱的收信轮询（Gmail 走 Pub/Sub 推送，不在这里）。
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
      // 改造：LinkedIn 的 JobRun / 订阅事件表随频道删除，这里只剩调度占位的清理。
      const prunedClaims = await pruneClaims();
      return { body: { ok: true, prunedClaims }, done: finished };
    }
    case "email-inbox-sync": {
      const summary = await runImapInboxSync();
      return { body: { ok: true, summary }, done: finished };
    }
  }
}
