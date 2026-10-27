import { describe, expect, test } from "bun:test";
import { parseFlatXml, WECOM_TEXT_TAGS } from "./xml";
import { clearWecomTokenCache, describeErrcode, wecomSignature, wecomSignatureMatches } from "./client";

/**
 * 企业微信适配器的纯逻辑：签名、错误码翻译、回调 XML 解析。
 *
 * 这三处最容易出错，而且错了都会以很难排查的方式表现：
 * 签名错 → 企微直接拒绝所有回调；错误码没翻译 → 销售看到 40013 不知道是啥；
 * XML 解析错 → 客户的回复静默丢失。
 */

describe("回调签名", () => {
  test("token/timestamp/nonce 排序后 SHA1，与顺序无关", () => {
    const a = wecomSignature("tok", "123", "abc");
    const b = wecomSignature("abc", "123", "tok");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  test("任一参数变化都会改变签名", () => {
    const base = wecomSignature("tok", "123", "abc");
    expect(wecomSignature("tok2", "123", "abc")).not.toBe(base);
    expect(wecomSignature("tok", "124", "abc")).not.toBe(base);
    expect(wecomSignature("tok", "123", "abd")).not.toBe(base);
  });

  test("校验函数按字面比对", () => {
    const sig = wecomSignature("tok", "123", "abc");
    expect(wecomSignatureMatches("tok", "123", "abc", sig)).toBe(true);
    expect(wecomSignatureMatches("tok", "123", "abc", "deadbeef")).toBe(false);
  });
});

describe("错误码翻译", () => {
  test("最常见几个都有人话", () => {
    expect(describeErrcode(40001, "")).toContain("access_token");
    expect(describeErrcode(45009, "")).toContain("频率");
    expect(describeErrcode(81013, "")).toContain("外部联系人");
    expect(describeErrcode(60111, "")).toContain("通讯录");
    expect(describeErrcode(40056, "")).toContain("AgentId");
  });

  test("没收录的带上原始 errmsg，方便对文档查", () => {
    expect(describeErrcode(99999, "some provider text")).toBe("some provider text");
    expect(describeErrcode(99999, "")).toContain("99999");
  });
});

describe("回调 XML 解析", () => {
  const sample = `<xml><ToUserName><![CDATA[ww123]]></ToUserName><FromUserName><![CDATA[wmABC]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[王总您好，明天方便吗]]></Content><MsgId>123456</MsgId></xml>`;

  test("取出企微文本消息的全部字段", () => {
    const fields = parseFlatXml(sample, WECOM_TEXT_TAGS);
    expect(fields).not.toBeNull();
    expect(fields!.ToUserName).toBe("ww123");
    expect(fields!.FromUserName).toBe("wmABC");
    expect(fields!.MsgType).toBe("text");
    expect(fields!.Content).toBe("王总您好，明天方便吗");
    expect(fields!.MsgId).toBe("123456");
  });

  test("只保留白名单里的标签", () => {
    const fields = parseFlatXml("<xml><ToUserName>a</ToUserName><Script>alert(1)</Script></xml>", WECOM_TEXT_TAGS);
    expect(fields!.ToUserName).toBe("a");
    expect(fields!.Script).toBeUndefined();
  });

  test("实体被还原，且 CDATA 原样保留", () => {
    expect(parseFlatXml("<xml><Content>a &amp; b</Content></xml>")!.Content).toBe("a & b");
    expect(parseFlatXml("<xml><Content><![CDATA[<b>x</b>]]></Content></xml>")!.Content).toBe("<b>x</b>");
  });

  test("不是 xml 根节点的直接拒绝，不给宽松解析留口子", () => {
    expect(parseFlatXml("<html><body>hi</body></html>")).toBeNull();
    expect(parseFlatXml("not xml at all")).toBeNull();
    expect(parseFlatXml("")).toBeNull();
  });

  test("空 xml 返回 null 而不是空对象", () => {
    expect(parseFlatXml("<xml></xml>")).toBeNull();
  });
});

describe("token 缓存", () => {
  test("清缓存不抛错（防止测试之间互相污染）", () => {
    expect(() => clearWecomTokenCache()).not.toThrow();
    expect(() => clearWecomTokenCache("ww123")).not.toThrow();
  });
});
