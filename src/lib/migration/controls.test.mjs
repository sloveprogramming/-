import { describe, expect, test } from "bun:test";
import {
  enabled,
  isMigrationControlPaused,
  migrationMutationBlockReason,
} from "./controls.ts";

/**
 * 改造：LinkedIn / WhatsApp 的出口开关与受限路由随频道删除，用例换成国内四渠道
 * 与仍然存在的接口。
 */
describe("People migration operational controls", () => {
  test("accepts only explicit truthy environment values", () => {
    expect(enabled("TRUE")).toBe(true);
    expect(enabled(" 1 ")).toBe(true);
    expect(enabled("false")).toBe(false);
    expect(enabled(undefined)).toBe(false);
  });

  test("master migration mode pauses every worker class", () => {
    const env = { PEOPLE_MIGRATION_MODE: "true" };
    for (const control of [
      "emailOutbound",
      "wecomOutbound",
      "smsOutbound",
      "callOutbound",
      "gridWorker",
    ]) {
      expect(isMigrationControlPaused(control, env)).toBe(true);
    }
  });

  test("narrow controls pause only their worker class", () => {
    const env = { PAUSE_SMS_OUTBOUND: "1" };
    expect(isMigrationControlPaused("smsOutbound", env)).toBe(true);
    expect(isMigrationControlPaused("callOutbound", env)).toBe(false);
    expect(isMigrationControlPaused("emailOutbound", env)).toBe(false);
  });

  test("migration mode blocks campaign mutations but preserves webhooks", () => {
    const env = { PEOPLE_MIGRATION_MODE: "on" };
    expect(migrationMutationBlockReason("/api/outreach/campaigns/abc", "PATCH", env)).toBeString();
    expect(migrationMutationBlockReason("/api/outreach/inbox/drafts/abc/approve", "POST", env)).toBeString();
    expect(migrationMutationBlockReason("/api/outreach/mailboxes/abc", "PATCH", env)).toBeString();
    expect(migrationMutationBlockReason("/api/outreach/webhooks/gmail-watch", "POST", env)).toBeNull();
    expect(migrationMutationBlockReason("/api/outreach/unsubscribe", "POST", env)).toBeNull();
    expect(migrationMutationBlockReason("/api/outreach/campaigns/abc", "GET", env)).toBeNull();
  });

  test("mutation-only pause remains active during selective worker canaries", () => {
    const env = { PEOPLE_MIGRATION_MODE: "false", PAUSE_CAMPAIGN_MUTATIONS: "true" };
    expect(migrationMutationBlockReason("/api/outreach/campaigns", "POST", env)).toBeString();
    expect(isMigrationControlPaused("emailOutbound", env)).toBe(false);
    expect(migrationMutationBlockReason("/api/outreach/unsubscribe", "POST", env)).toBeNull();
  });
});
