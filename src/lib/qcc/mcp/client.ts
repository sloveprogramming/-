import "server-only";

/**
 * 企查查 MCP 客户端（手写极简版，零新增依赖）。
 *
 * ## 为什么不装 @modelcontextprotocol/sdk
 *
 * 我们只用最基础的一档能力：`tools/call`（发一个 JSON-RPC 请求，拿一个结果）。
 * 完整的 MCP SDK 要管 initialize 握手、session、SSE 长连接、能力协商、prompt/
 * resource 订阅——这些在"服务端主动调一次工具"的场景里全是负担。
 *
 * 实测（2026-10-30）：这个端点**不要求 session**，直接 POST `tools/call` 就能
 * 拿到结果。所以整个客户端就是 fetch + 解析 SSE + 剥两层 JSON。
 *
 * ## 两层 JSON 是什么
 *
 * MCP 的返回是 `{ result: { content: [{ type: "text", text: "..." }] } }`，
 * 而 `text` 里又是一段 JSON 字符串（企查查自己的业务结构）。所以要用两次
 * `JSON.parse` —— 第一次解 MCP 外壳，第二次解业务数据。
 *
 * ## 错误一律不抛
 *
 * 工具层的约定是"失败回灌给模型，让它换个查法"，所以这里返回
 * `{ ok: false, error }`，由调用方决定怎么办。
 */

export const QCC_MCP_DOMAINS = ["company", "risk", "ipr", "operation", "executive"] as const;
export type QccMcpDomain = (typeof QCC_MCP_DOMAINS)[number];

/** 每个域对应一个 endpoint，域名部分可用 env 覆盖（比如走代理）。 */
const DOMAIN_PATHS: Record<QccMcpDomain, string> = {
  company: "company",
  risk: "risk",
  ipr: "ipr",
  operation: "operation",
  executive: "executive",
};

const DEFAULT_TIMEOUT_MS = 25_000;

function baseUrl(): string {
  return process.env.QCC_MCP_BASE_URL?.trim().replace(/\/+$/, "") || "https://agent.qcc.com/mcp";
}

function token(): string {
  return process.env.QCC_MCP_TOKEN?.trim() ?? "";
}

/** 有没有配 token。没配时上层工具直接返回"未配置"，不发请求。 */
export function qccMcpConfigured(): boolean {
  return Boolean(token());
}

export type QccToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * 调一个企查查 MCP 工具。
 *
 * 参数统一是 `{ searchKey }`（完整企业名或 18 位统一社会信用代码）+ 少量可选
 * 过滤项。**不接受简称**——企查查要求先用 `get_company_by_query` 做实体识别，
 * 这一步由上层决定要不要做，客户端不替它猜。
 */
export async function callQccTool(input: {
  domain: QccMcpDomain;
  tool: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<QccToolResult> {
  const authToken = token();
  if (!authToken) return { ok: false, error: "企查查 MCP 未配置（缺少 QCC_MCP_TOKEN）" };

  const url = `${baseUrl()}/${DOMAIN_PATHS[input.domain]}/stream`;
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // AbortSignal.timeout 与外部 signal 合并：任一触发就中断。
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
        // 必须声明接受 SSE，否则部分网关直接返回 406。
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: input.tool, arguments: input.args },
      }),
      signal,
    });
  } catch (error) {
    // 注意：错误信息里不能出现 Authorization，日志会被别人看到。
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `企查查 MCP 请求失败：${reason}` };
  }

  if (!response.ok) {
    // 401/403 多半是 token 过期或该域没授权；429 是限流。
    const hint = response.status === 401 || response.status === 403
      ? "（token 失效或该数据域未授权）"
      : response.status === 429
        ? "（调用频率超限）"
        : "";
    return { ok: false, error: `企查查 MCP 返回 HTTP ${response.status}${hint}` };
  }

  const body = await response.text().catch(() => "");
  if (!body.trim()) return { ok: false, error: "企查查 MCP 返回空响应" };

  const envelope = extractJsonRpc(body);
  if (!envelope) return { ok: false, error: "企查查 MCP 返回无法解析的响应" };

  if (envelope.error) {
    const message = typeof envelope.error === "object" && envelope.error && "message" in envelope.error
      ? String((envelope.error as { message?: unknown }).message ?? "")
      : "未知错误";
    return { ok: false, error: `企查查 MCP 错误：${message || "未知错误"}` };
  }

  const content = (envelope.result as { content?: unknown } | undefined)?.content;
  const first = Array.isArray(content) ? content[0] : null;
  const text = first && typeof first === "object" && first !== null && "text" in first
    ? String((first as { text?: unknown }).text ?? "")
    : "";
  if (!text.trim()) return { ok: false, error: "企查查 MCP 没有返回内容" };

  // 第二层解析：企查查的业务数据在 text 里是一段 JSON 字符串。
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    // 有些工具（比如报错路径）返回的是纯文本，原样带出去比丢掉更有用。
    return { ok: true, data: { text } };
  }
}

type JsonRpcEnvelope = {
  result?: unknown;
  error?: unknown;
};

/**
 * 从 SSE 响应体里捞出最后一个 JSON-RPC 消息。
 *
 * 取最后一个而不是第一个：流式端点会先发心跳/中间事件，最终结果在末尾。
 */
export function extractJsonRpc(body: string): JsonRpcEnvelope | null {
  for (const data of sseDataLines(body).reverse()) {
    try {
      const parsed = JSON.parse(data) as JsonRpcEnvelope;
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
        return parsed;
      }
    } catch {
      // 不是 JSON 的行（心跳、注释）跳过。
    }
  }
  // 有些网关直接返回纯 JSON，没有 SSE 包装。
  try {
    const parsed = JSON.parse(body) as JsonRpcEnvelope;
    if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) return parsed;
  } catch {
    // 忽略
  }
  return null;
}

/** 按 SSE 规范取出所有 data 字段（多行 data 用换行拼接）。 */
export function sseDataLines(body: string): string[] {
  const out: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    if (buffer.length) {
      out.push(buffer.join("\n"));
      buffer = [];
    }
  };
  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine === "") {
      flush();
      continue;
    }
    if (rawLine.startsWith(":")) continue;
    const index = rawLine.indexOf(":");
    if (index < 0) continue;
    const field = rawLine.slice(0, index);
    if (field !== "data") continue;
    // 规范：冒号后若有一个空格要去掉。
    const value = rawLine.slice(index + 1).replace(/^ /, "");
    buffer.push(value);
  }
  flush();
  return out;
}
