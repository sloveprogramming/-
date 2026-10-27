import { describe, expect, test } from "bun:test";
import { leadSignalsFromRow, pickCustom, toBoolean, toNumber, toScale } from "./fromLead";
import { scoreLead } from "./score";

/**
 * 线索行 → 评分信号。这一层最容易出错的地方是**字段别名**：导入的表格
 * 千奇百怪，"门店数" / "门店数量" / "storeCount" 都得认，"是" / "有" / "1" 都得
 * 当成 true。测试就是把这些写法钉住。
 */

describe("pickCustom", () => {
  test("别名、大小写、空格与下划线都不敏感", () => {
    const custom = { "门店数量": "80" };
    expect(pickCustom(custom, ["门店数", "门店数量"])).toBe("80");
    expect(pickCustom({ store_count: "12" }, ["storeCount", "store_count"])).toBe("12");
    expect(pickCustom({ "Store Count": "9" }, ["store_count"])).toBe("9");
  });

  test("空值不算命中，继续找下一个别名", () => {
    expect(pickCustom({ 门店数: "", 门店数量: "3" }, ["门店数", "门店数量"])).toBe("3");
    expect(pickCustom({ 门店数: null }, ["门店数"])).toBeUndefined();
  });
});

describe("值转换", () => {
  test("布尔：中文、英文、数字都认", () => {
    for (const value of ["是", "有", "true", "1", "YES", 1, true]) expect(toBoolean(value)).toBe(true);
    for (const value of ["否", "没有", "无", "false", "0", "no", 0, false]) expect(toBoolean(value)).toBe(false);
    expect(toBoolean("说不好")).toBeNull();
    expect(toBoolean(undefined)).toBeNull();
  });

  test("数字：容忍单位和千分位", () => {
    expect(toNumber("80 家")).toBe(80);
    expect(toNumber("1,200")).toBe(1200);
    expect(toNumber(15)).toBe(15);
    expect(toNumber("很多")).toBeNull();
  });

  test("规模档位", () => {
    expect(toScale("中型")).toBe("mid");
    expect(toScale("10人以下")).toBe("micro");
    expect(toScale("300人以上")).toBe("large");
    expect(toScale("不清楚")).toBeNull();
  });
});

describe("线索行 → 信号", () => {
  const richRow = {
    person: {
      fullName: "王建国",
      title: "采购总监",
      email: "wang@example.com",
      phone: "13800138000",
      custom: {
        行业: "休闲食品批发",
        食品经营许可证: "有",
        成立年限: "12",
        公司规模: "中型",
        门店数量: "36 家",
        有电商店: "是",
        在卖坚果: "有",
        分销网络: "是",
        在招渠道: "是",
        近期招标: "无",
        参展: "1",
        已加企微: "是",
      },
    },
    company: { name: "某某食品有限公司", domain: "example.com" },
  };

  test("字段齐全时能拿到 A 级", () => {
    const signals = leadSignalsFromRow(richRow);
    const result = scoreLead(signals);
    expect(result.grade).toBe("A");
    expect(signals.storeCount).toBe(36);
    expect(signals.scale).toBe("mid");
    expect(signals.recentTender).toBe(false);
    expect(signals.hasMobile).toBe(true);
    expect(signals.decisionMakerIdentified).toBe(true);
    // 资质、渠道、触达都接近满分，只有需求信号还缺——提示要精准，不能瞎喊。
    expect(result.nextChecks.join("")).not.toContain("企业底细");
    expect(result.nextChecks.join("")).toContain("需求信号");
  });

  test("只有姓名和邮箱时是 C 级，并提示还缺什么", () => {
    const result = scoreLead(leadSignalsFromRow({ person: { fullName: "张三", email: "z@example.com" }, company: null }));
    expect(result.grade).toBe("C");
    expect(result.nextChecks.length).toBeGreaterThan(0);
  });

  test("没有行业字段时，从公司名推断", () => {
    expect(leadSignalsFromRow({ person: {}, company: { name: "临安坚果炒货有限公司" } }).industryMatch).toBe(true);
    expect(leadSignalsFromRow({ person: {}, company: { name: "某某机械制造有限公司" } }).industryMatch).toBe(false);
    expect(leadSignalsFromRow({ person: {}, company: null }).industryMatch).toBeNull();
  });

  test("职位决定是否算找到决策人", () => {
    expect(leadSignalsFromRow({ person: { title: "老板" } }).decisionMakerIdentified).toBe(true);
    expect(leadSignalsFromRow({ person: { title: "采购经理" } }).decisionMakerIdentified).toBe(true);
    expect(leadSignalsFromRow({ person: { title: "实习生" } }).decisionMakerIdentified).toBe(false);
    expect(leadSignalsFromRow({ person: { title: null } }).decisionMakerIdentified).toBeNull();
  });

  test("手机号决定触达可达性", () => {
    expect(leadSignalsFromRow({ person: { phone: "13800138000" } }).hasMobile).toBe(true);
    expect(leadSignalsFromRow({ person: { phone: "  " } }).hasMobile).toBe(false);
  });
});
