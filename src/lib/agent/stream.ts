import "server-only";

import type { AgentStepEvent } from "./events";

/**
 * 流式输出的 SSE 封装。
 *
 * ## 用途
 *
 * 起草时让销售**看着 AI 一个字一个字写出来**，而不是等 10 秒白屏。
 * 这不只是体验问题：用户看到进度就知道系统没卡死，也更容易中途取消。
 *
 * ## 为什么用 SSE 而不是 WebSocket
 *
 * - 单向推送（服务端 → 浏览器）就够了
 * - 走普通 HTTP，Next.js 的 route handler 原生支持
 * - 不需要额外的基础设施（WebSocket 要自己管连接、心跳、重连）
 *
 * ## 踩过的三个坑（都写在这里，免得下次再踩）
 *
 * 1. **代理会缓冲响应**：Nginx / Cloudflare 默认攒够一定字节才转发，导致
 *    用户看到的是"卡很久然后一次性全出来"。必须发 `X-Accel-Buffering: no`，
 *    并每 15 秒发一个注释行心跳（`:` 开头）保持连接活跃。
 * 2. **客户端断开要中止模型调用**：否则 token 继续烧，钱白花。监听
 *    `request.signal` 的 abort 事件。
 * 3. **错误要作为事件发出去**，不能直接 throw —— throw 之后连接已经关了，
 *    前端只会看到"网络错误"，不知道真正原因。
 */

export type StreamEvent =
  /** 文本增量。 */
  | { type: "delta"; text: string }
  /** Agent 的一次工具调用或模型调用（便于前端显示"正在查知识库…"）。 */
  | { type: "step"; event: AgentStepEvent }
  /** 正常结束，带完整文本。 */
  | { type: "done"; text: string }
  /** 出错。 */
  | { type: "error"; message: string };

/** SSE 的默认头。 */
export const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 关键：告诉 Nginx 不要缓冲。少了这一行，用户看到的是"卡住然后一次性出来"。
  "X-Accel-Buffering": "no",
};

/** 心跳间隔：15 秒。太短浪费，太长会被代理判定空闲断开。 */
const HEARTBEAT_MS = 15_000;

/**
 * 构造一个 SSE 响应。
 *
 * @param runner 实际执行逻辑。它通过 `emit` 往外推事件，通过 `signal` 感知取消。
 */
export function createSseResponse(
  request: Pick<Request, "signal">,
  runner: (emit: (event: StreamEvent) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          streamController.enqueue(encoder.encode(chunk));
        } catch {
          // 客户端已经断开：忽略，避免往已关闭的流里写导致二次报错。
          closed = true;
        }
      };

      const send = (event: StreamEvent) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
      };

      // 心跳：注释行，浏览器会忽略，但能让代理和客户端知道连接还活着。
      const heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);

      // 客户端断开时中止模型调用，避免继续烧 token。
      request.signal?.addEventListener("abort", () => {
        controller.abort();
      }, { once: true });

      runner(send, controller.signal)
        .catch((error: unknown) => {
          // 错误必须作为事件发出去：此时连接还在，throw 出去前端只会看到网络错误。
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          clearInterval(heartbeat);
          closed = true;
          try {
            streamController.close();
          } catch {
            // 已关闭时忽略。
          }
        });
    },
    cancel() {
      // 浏览器取消订阅（关页面）：同样要中止上游。
      controller.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/**
 * 把纯文本按句分段，模拟"一个字一个字写"的流式效果。
 *
 * 为什么需要：Pi 的 `session.prompt()` 是一次性返回的，没有 token 级回调给
 * 调用方。对于「AI 起草」这种已经拿到完整文本的场景，按句推送仍能给出进度感，
 * 实现成本几乎为零。
 *
 * **核心保证：分片拼回去必须等于原文。**
 *
 * 早期实现用 `matchAll(/[^标点]+[标点]?/)`，会漏掉纯换行的片段——`\n\n`
 * 匹配不到任何东西，于是段落间隔被吞掉，信件到前端就变成没有空行的一坨。
 * 现在按标点切分（lookbehind 让分隔符留在前一片段），纯空白片段单独保留。
 */
export function chunkTextForStreaming(text: string): string[] {
  if (!text) return [""];

  // lookbehind 在标点后切分，分隔符留在前一片段。
  // 结果天然就是"每片以标点结尾"，不需要再合并。
  const raw = text.split(/(?<=[。！？；\.\!\?;\n])/).filter(Boolean);
  if (!raw.length) return [text];

  const pieces: string[] = [];
  for (const piece of raw) {
    const previous = pieces[pieces.length - 1];
    // 只有一种情况需要合并：上一片是纯空白（如 "\n\n"），而这一片也以空白
    // 开头的话不需要合并；但如果上一片**没有**标点结尾（超长无标点句），
    // 才把下一片接上去，避免把一个长句拆散。
    if (previous !== undefined && !/^\s+$/.test(previous) && !/[。！？；\.\!\?;\n]$/.test(previous)) {
      pieces[pieces.length - 1] = previous + piece;
      continue;
    }
    pieces.push(piece);
  }

  // 防御性检查：拼不回去就退回整段（宁可没有流式效果，也不能丢内容）。
  return pieces.length && pieces.join("") === text ? pieces : [text];
}
