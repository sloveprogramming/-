import { describe, expect, test } from "bun:test";
import { deriveImapHost, describeImapError } from "./imap";

/**
 * IMAP 收信的纯逻辑部分。真正的收发要连服务器，这里测两件容易出错的事：
 * 主机名推导（国内三家的命名规律）和报错翻译。
 */
describe("deriveImapHost", () => {
  test("国内三家的命名规律", () => {
    expect(deriveImapHost("smtp.exmail.qq.com")).toBe("imap.exmail.qq.com");
    expect(deriveImapHost("smtp.qiye.aliyun.com")).toBe("imap.qiye.aliyun.com");
    expect(deriveImapHost("smtphz.qiye.163.com")).toBe("imaphz.qiye.163.com");
  });

  test("不是 smtp 开头的原样返回，不瞎改", () => {
    expect(deriveImapHost("mail.example.com")).toBe("mail.example.com");
    expect(deriveImapHost("mx1.corp.local")).toBe("mx1.corp.local");
  });
});

describe("describeImapError", () => {
  test("认证失败指向「单独开启 IMAP + 客户端专用密码」", () => {
    expect(describeImapError(new Error("AUTHENTICATIONFAILED"))).toContain("IMAP");
    expect(describeImapError(new Error("LOGIN failed"))).toContain("客户端专用密码");
  });

  test("连不上指向主机与端口", () => {
    expect(describeImapError(new Error("connect ETIMEDOUT"))).toContain("993");
    expect(describeImapError(new Error("ENOTFOUND imap.example.com"))).toContain("连不上");
  });

  test("其它错误原样透出", () => {
    expect(describeImapError(new Error("Mailbox does not exist"))).toBe("Mailbox does not exist");
  });
});
