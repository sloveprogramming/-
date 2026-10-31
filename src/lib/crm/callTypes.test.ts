import { describe, expect, test } from "bun:test";
import {
  ALLOWED_INTENTS,
  CALL_INTENT_LABEL,
  CALL_OUTCOME_LABEL,
  CALL_OUTCOMES,
  coerceIntent,
  intentsFor,
  validateCallLog,
  type CallIntent,
} from "./callTypes";

/**
 * 通话结果的校验规则。
 *
 * 这些规则看着像"表单洁癖"，其实是防止数据被污染：如果允许"没接通"标"有意向"，
 * 一周之后统计出来的意向数全是假的，销售自己都不信。所以钉死。
 */

describe("结果与意向的搭配", () => {
  test("每个结果都有中文名", () => {
    for (const outcome of CALL_OUTCOMES) {
      expect(CALL_OUTCOME_LABEL[outcome]).toBeTruthy();
    }
  });

  test("每个意向都有中文名", () => {
    for (const intent of ["interested", "needs_follow_up", "not_interested", "unknown"] as CallIntent[]) {
      expect(CALL_INTENT_LABEL[intent]).toBeTruthy();
    }
  });

  test("没接通只能选「说不清」", () => {
    expect(intentsFor("unreachable")).toEqual(["unknown"]);
  });

  test("明确拒绝只能选「无意向」", () => {
    expect(intentsFor("rejected")).toEqual(["not_interested"]);
  });

  test("接通了四种意向都能选", () => {
    expect(intentsFor("connected")).toHaveLength(4);
  });

  test("前台挡下不能标「有意向」", () => {
    expect(ALLOWED_INTENTS.gatekeeper).not.toContain("interested");
  });
});

describe("切换结果时纠正意向", () => {
  test("从「接通+有意向」切到「未接通」，意向自动变成说不清", () => {
    expect(coerceIntent("unreachable", "interested")).toBe("unknown");
  });

  test("从「接通+有意向」切到「明确拒绝」，意向变成无意向", () => {
    expect(coerceIntent("rejected", "interested")).toBe("not_interested");
  });

  test("合法组合保持不动", () => {
    expect(coerceIntent("connected", "needs_follow_up")).toBe("needs_follow_up");
  });
});

describe("提交校验", () => {
  test("合法组合通过", () => {
    expect(validateCallLog({ outcome: "connected", intent: "interested", notes: "聊得不错" })).toBeNull();
  });

  test("非法组合被拒，且提示说清哪两个不能配", () => {
    const error = validateCallLog({ outcome: "unreachable", intent: "interested", notes: "" });
    expect(error).toContain("未接通");
    expect(error).toContain("有意向");
  });

  test("要点超长被拒", () => {
    const error = validateCallLog({ outcome: "connected", intent: "interested", notes: "字".repeat(2_001) });
    expect(error).toContain("2000");
  });

  test("要点为空是允许的（不强制写）", () => {
    expect(validateCallLog({ outcome: "connected", intent: "interested", notes: "" })).toBeNull();
  });
});
