import { describe, expect, test } from "bun:test";
import { chunkTextForStreaming, SSE_HEADERS } from "./stream";

/**
 * 流式输出。
 *
 * SSE 的核心风险不是"能不能推"，而是**推不出去却看不出来**：
 * 代理缓冲让用户以为卡死、客户端断开后还在烧 token、错误被吞掉只显示网络错误。
 * 所以测试重点在协议细节而不是渲染效果。
 */

describe("SSE 响应头", () => {
  test("必须是 text/event-stream", () => {
    expect(SSE_HEADERS["Content-Type"]).toContain("text/event-stream");
  });

  test("必须告诉代理不要缓冲", () => {
    // 少了这一行，用户看到的是"卡很久然后一次性全出来"。
    expect(SSE_HEADERS["X-Accel-Buffering"]).toBe("no");
  });

  test("必须禁用内容转换（否则压缩会攒包）", () => {
    expect(SSE_HEADERS["Cache-Control"]).toContain("no-transform");
  });
});

describe("按句切分（假流式的推送粒度）", () => {
  test("中文句子按标点切开，标点保留", () => {
    const pieces = chunkTextForStreaming("第一句。第二句！第三句？");
    expect(pieces).toEqual(["第一句。", "第二句！", "第三句？"]);
  });

  test("换行也作为分段点（信件正文常按行分段）", () => {
    const pieces = chunkTextForStreaming("陈总您好，\n\n感谢回复。");
    expect(pieces.length).toBeGreaterThan(1);
    // 拼回去应该等于原文（不能丢内容）
    expect(pieces.join("")).toBe("陈总您好，\n\n感谢回复。");
  });

  test("没有标点时整段返回，不丢内容", () => {
    const text = "没有标点的一段话";
    expect(chunkTextForStreaming(text)).toEqual([text]);
  });

  test("空文本返回单个空串而不是空数组（避免前端以为没结果）", () => {
    expect(chunkTextForStreaming("")).toEqual([""]);
  });

  test("分片拼回等于原文（这是最关键的保证）", () => {
    const text = "陈总您好，\n感谢您的回复。\n\n关于起订量：常规货 50 箱起，OEM 200 箱起。\n\n新农哥";
    expect(chunkTextForStreaming(text).join("")).toBe(text);
  });

  test("推送粒度不会过密（一份 800 字的信不应产生 800 个事件）", () => {
    const letter = "这是句子。".repeat(100);
    const pieces = chunkTextForStreaming(letter);
    expect(pieces.length).toBeLessThanOrEqual(101);
  });
});
