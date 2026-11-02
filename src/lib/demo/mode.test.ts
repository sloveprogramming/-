import { describe, expect, test } from "bun:test";
import { demoRequestBlock, isDemoMode } from "./mode";

const demo = { DEMO_MODE: "true" };

describe("isDemoMode", () => {
  test("is off unless DEMO_MODE is a true value", () => {
    expect(isDemoMode({})).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "false" })).toBe(false);
    expect(isDemoMode({ DEMO_MODE: "1" })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: " TRUE " })).toBe(true);
  });
});

describe("demoRequestBlock", () => {
  test("does nothing outside the demo", () => {
    expect(demoRequestBlock("/api/crm/records", "POST", {})).toBeNull();
    expect(demoRequestBlock("/sign-in", "GET", {})).toBeNull();
  });

  test("sends the sign-in screens to the demo's front door", () => {
    for (const path of ["/sign-in", "/sign-up", "/login", "/forgot-password", "/reset-password", "/onboarding", "/accept-invitation/abc"]) {
      expect(demoRequestBlock(path, "GET", demo)).toEqual({ kind: "enter" });
    }
  });

  test("lets reads through", () => {
    expect(demoRequestBlock("/analytics", "GET", demo)).toBeNull();
    expect(demoRequestBlock("/api/crm/actions", "GET", demo)).toBeNull();
    expect(demoRequestBlock("/api/linkedin/messages/thread", "GET", demo)).toBeNull();
  });

  test("refuses every write", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(demoRequestBlock("/api/outreach/campaigns", method, demo)).toEqual({ kind: "refuse" });
    }
    expect(demoRequestBlock("/api/webhooks/unipile-message", "POST", demo)).toEqual({ kind: "refuse" });
    expect(demoRequestBlock("/api/outreach/tick", "POST", demo)).toEqual({ kind: "refuse" });
  });

  test("refuses reads that start paid or background work", () => {
    expect(demoRequestBlock("/api/qualify", "GET", demo)).toEqual({ kind: "refuse" });
    expect(demoRequestBlock("/api/campaigns/123/stream", "GET", demo)).toEqual({ kind: "refuse" });
  });

  test("allows Better Auth's reads and organization switching, nothing else", () => {
    expect(demoRequestBlock("/api/auth/get-session", "GET", demo)).toBeNull();
    expect(demoRequestBlock("/api/auth/organization/list-members", "GET", demo)).toBeNull();
    expect(demoRequestBlock("/api/auth/organization/list-teams", "GET", demo)).toBeNull();
    expect(demoRequestBlock("/api/auth/verify-email", "GET", demo)).toEqual({ kind: "refuse" });
    expect(demoRequestBlock("/api/auth/callback/google", "GET", demo)).toEqual({ kind: "refuse" });
    expect(demoRequestBlock("/api/auth/organization/set-active", "POST", demo)).toBeNull();
    for (const path of ["/api/auth/sign-out", "/api/auth/sign-up/email", "/api/auth/change-password", "/api/auth/organization/create", "/api/auth/organization/invite-member"]) {
      expect(demoRequestBlock(path, "POST", demo)).toEqual({ kind: "refuse" });
    }
  });

  test("answers writes the UI fires on its own with a quiet success", () => {
    expect(demoRequestBlock("/api/outreach/inbox/messages/42/opened", "POST", demo)).toEqual({ kind: "silent" });
    expect(demoRequestBlock("/api/whatsapp/chats/abc/read", "POST", demo)).toEqual({ kind: "silent" });
  });

  test("lets read-only POSTs through", () => {
    expect(demoRequestBlock("/api/grid/tables/t1/export", "POST", demo)).toBeNull();
    expect(demoRequestBlock("/api/grid/tables/t1/formula-preview", "POST", demo)).toBeNull();
    expect(demoRequestBlock("/api/grid/tables/t1/formula-generate", "POST", demo)).toEqual({ kind: "refuse" });
  });
});
