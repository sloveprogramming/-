import { describe, expect, test } from "bun:test";
import { mapQccRow, qccToken } from "./client";

/**
 * 企查查适配器的纯逻辑：签名与字段映射。
 *
 * 这两处是最容易出问题的地方——签名算错会被直接拒掉，字段名对不上会得到一堆
 * 空行。用真实账号验证之前，先用这里把行为钉住。
 */

describe("签名", () => {
  test("MD5(key + timestamp + secret)，全大写", () => {
    // 固定输入，结果可复现；大小写敏感（企查查要求大写）。
    const token = qccToken("mykey", "1700000000", "mysecret");
    expect(token).toMatch(/^[0-9A-F]{32}$/);
    expect(token).toBe(token.toUpperCase());
    // 同样的输入必须得到同样的结果。
    expect(qccToken("mykey", "1700000000", "mysecret")).toBe(token);
    // 任何一个输入变化都会改变结果。
    expect(qccToken("mykey", "1700000001", "mysecret")).not.toBe(token);
    expect(qccToken("other", "1700000000", "mysecret")).not.toBe(token);
  });
});

describe("字段映射", () => {
  test("标准字段", () => {
    const hit = mapQccRow({
      Name: "临安新农哥食品有限公司",
      CreditCode: "91330100MA2XXXXXXX",
      OperName: "余某某",
      StartDate: "2006-09-01",
      RegistCapi: "500万元人民币",
      Province: "浙江省",
      City: "杭州市",
      District: "临安区",
      Industry: "食品制造业",
      Status: "存续",
      Phone: "0571-88887777",
      Scope: "坚果炒货生产、销售",
    });
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe("临安新农哥食品有限公司");
    expect(hit!.region).toBe("浙江省 杭州市 临安区");
    expect(hit!.phones).toEqual(["0571-88887777"]);
    expect(hit!.legalPerson).toBe("余某某");
    expect(hit!.inLibrary).toBe(false);
  });

  test("字段名大小写/别名都能认", () => {
    const hit = mapQccRow({
      name: "某某食品厂",
      creditCode: "123",
      legalPersonName: "张三",
      establishDate: "2010-01-01",
      industryName: "批发业",
    });
    expect(hit!.name).toBe("某某食品厂");
    expect(hit!.creditCode).toBe("123");
    expect(hit!.legalPerson).toBe("张三");
    expect(hit!.foundedAt).toBe("2010-01-01");
    expect(hit!.industry).toBe("批发业");
  });

  test("没有地区字段时退回地址", () => {
    const hit = mapQccRow({ Name: "某公司", Address: "浙江省杭州市临安区XX路1号" });
    expect(hit!.region).toBe("浙江省杭州市临安区XX路1号");
  });

  test("电话支持数组和分号分隔", () => {
    expect(mapQccRow({ Name: "A", Phone: ["1", "2"] })!.phones).toEqual(["1", "2"]);
    expect(mapQccRow({ Name: "A", Phone: "1；2" })!.phones).toEqual(["1", "2"]);
    expect(mapQccRow({ Name: "A" })!.phones).toEqual([]);
  });

  test("没有公司名的行被丢弃，不产生空记录", () => {
    expect(mapQccRow({ CreditCode: "123" })).toBeNull();
    expect(mapQccRow({ Name: "   " })).toBeNull();
  });

  test("信用代码缺失时用名字做 key，保证结果可选中", () => {
    expect(mapQccRow({ Name: "无代码公司" })!.key).toBe("无代码公司");
  });
});
