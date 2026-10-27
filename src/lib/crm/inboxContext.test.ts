import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inboxCrmStepLabel, type InboxCrmStep, type InboxCrmSummary } from "./inboxContext";

const NOW = new Date("2026-09-19T12:00:00Z");

const summary = (overrides: Partial<InboxCrmSummary> = {}): InboxCrmSummary => ({
  recordId: "rec",
  workflowState: "waiting",
  categoryKey: "interested",
  subcategoryId: null,
  subcategoryName: null,
  nextActionAt: null,
  sequenceName: "Interested",
  step: null,
  hasDraft: false,
  ...overrides,
});

const step = (overrides: Partial<InboxCrmStep> = {}): InboxCrmStep => ({
  position: 2,
  total: 4,
  name: "Follow-up 1",
  type: "follow_up",
  status: "scheduled",
  dueAt: null,
  ...overrides,
});

describe("inboxCrmStepLabel", () => {
  test("workflow state wins over the step", () => {
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "closed", step: step() }), NOW), "已关闭");
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "paused" }), NOW), "已暂停");
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "error" }), NOW), "需要处理");
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "classifying" }), NOW), "识别中");
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "unclassified" }), NOW), "识别中");
  });

  test("no run: falls back to the draft flag", () => {
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "action_required", hasDraft: true }), NOW), "回复已起草");
    assert.equal(inboxCrmStepLabel(summary({ workflowState: "idle" }), NOW), "暂无下一步");
  });

  test("reply step drafted or drafting", () => {
    const reply = step({ position: 1, type: "reply", name: "Reply" });
    assert.equal(inboxCrmStepLabel(summary({ step: { ...reply, status: "awaiting_review" } }), NOW), "回复已起草");
    assert.equal(inboxCrmStepLabel(summary({ step: { ...reply, status: "drafting" } }), NOW), "回复起草中");
    assert.equal(inboxCrmStepLabel(summary({ step: { ...reply, status: "failed" } }), NOW), "回复失败");
  });

  test("follow-up numbering is position minus the reply step", () => {
    assert.equal(inboxCrmStepLabel(summary({ step: step({ position: 3, status: "awaiting_review" }) }), NOW), "第 2 次跟进已起草");
  });

  test("scheduled follow-up reports relative due time", () => {
    assert.equal(inboxCrmStepLabel(summary({ step: step({ dueAt: "2026-09-22T12:00:00Z" }) }), NOW), "第 1 次跟进·3 天后到期");
    assert.equal(inboxCrmStepLabel(summary({ step: step({ dueAt: "2026-09-19T15:30:00Z" }) }), NOW), "第 1 次跟进·4 小时后到期");
    assert.equal(inboxCrmStepLabel(summary({ step: step({ dueAt: "2026-09-19T11:00:00Z" }) }), NOW), "第 1 次跟进·现在到期");
    assert.equal(inboxCrmStepLabel(summary({ step: step({ dueAt: null }) }), NOW), "第 1 次跟进已排期");
  });
});
