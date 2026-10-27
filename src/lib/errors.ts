/**
 * 把任意抛出物变成一句可读的错误描述，给定时任务、接口日志和页面的错误态用。
 *
 * 原来这个函数住在 `src/lib/linkedin/serializeError.ts`，里面一大半逻辑是解析
 * Unipile SDK 的错误体（`.body` / `.response.data`）。Unipile 删掉之后那部分没有
 * 意义了，这里保留通用形状：Error 的消息优先，其次 stack，再其次 JSON。
 */
export function serializeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) return message;
    return error.stack ?? "未知错误";
  }
  if (typeof error === "string") return error;
  if (error == null) return "未知错误";
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
