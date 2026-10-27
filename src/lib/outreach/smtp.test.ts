import { describe, expect, test } from "bun:test";
import { SMTP_PRESETS, describeSmtpError } from "./smtp";

/**
 * SMTP 发信的错误翻译与预设。真正的收发要连服务器，这里只测纯逻辑：
 * 一个能看懂的报错，比一句 "Invalid login: 535" 对销售/管理员有用得多。
 */
describe("describeSmtpError", () => {
  test("认证失败指向「客户端专用密码」这个最常见的坑", () => {
    for (const message of ["Invalid login: 535 Authentication failed", "EAUTH", "Authentication unsuccessful"]) {
      expect(describeSmtpError(new Error(message))).toContain("客户端专用密码");
    }
  });

  test("连不上指向主机/端口/外发权限", () => {
    for (const message of ["connect ETIMEDOUT 1.2.3.4:465", "ECONNREFUSED", "getaddrinfo ENOTFOUND smtp.example.com"]) {
      expect(describeSmtpError(new Error(message))).toContain("连不上");
    }
  });

  test("证书问题给出可执行的下一步", () => {
    expect(describeSmtpError(new Error("self signed certificate in certificate chain"))).toContain("证书");
  });

  test("其它错误原样透出，不吞信息", () => {
    expect(describeSmtpError(new Error("Mailbox full"))).toBe("Mailbox full");
    expect(describeSmtpError("boom")).toBe("boom");
  });
});

describe("SMTP_PRESETS", () => {
  test("国内三家都在，且端口与加密方式自洽", () => {
    const hosts = SMTP_PRESETS.map((preset) => preset.host).filter(Boolean);
    expect(hosts).toContain("smtp.exmail.qq.com");
    expect(hosts).toContain("smtp.qiye.aliyun.com");
    expect(hosts).toContain("smtphz.qiye.163.com");
    for (const preset of SMTP_PRESETS) {
      // 465 必须是 SSL 直连；其它端口走 STARTTLS。
      expect(preset.secure).toBe(preset.port === 465);
    }
  });
});
