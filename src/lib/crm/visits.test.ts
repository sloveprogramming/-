import { describe, expect, test } from "bun:test";
import { VISIT_OUTCOME_LABEL, VISIT_STATUS_LABEL, type VisitOutcome, type VisitStatus } from "./visits";

/**
 * 拜访的状态机与文案。
 *
 * 状态流转本身依赖数据库（在 visits.ts 的 transitionVisit 里），这里只钉住
 * "文案齐全"和"状态集合完整"——这两样错了，界面会显示空白或者 undefined，
 * 而那种 bug 在测试里抓不到、在页面上很显眼但有损专业感。
 */

describe("拜访状态", () => {
  test("四种状态都有中文名", () => {
    const statuses: VisitStatus[] = ["planned", "checked_in", "completed", "cancelled"];
    for (const status of statuses) {
      expect(VISIT_STATUS_LABEL[status]).toBeTruthy();
      expect(VISIT_STATUS_LABEL[status]).not.toContain("undefined");
    }
    expect(VISIT_STATUS_LABEL.planned).toBe("已安排");
    expect(VISIT_STATUS_LABEL.checked_in).toBe("已到场");
  });

  test("三种结果都有中文名", () => {
    const outcomes: VisitOutcome[] = ["advanced", "follow_up_needed", "no_progress"];
    for (const outcome of outcomes) {
      expect(VISIT_OUTCOME_LABEL[outcome]).toBeTruthy();
    }
    expect(VISIT_OUTCOME_LABEL.advanced).toBe("有推进");
  });
});
