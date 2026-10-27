import "server-only";

import { createHash } from "node:crypto";

/**
 * 企业微信 API 客户端（自建应用）。
 *
 * 两个关键约束，都来自企微自己的设计，踩过才知道：
 *
 * 1. **access_token 只有 7200 秒有效期，且获取有频次上限**（两次获取太频繁会
 *    返回 45009）。所以必须缓存，不能每个请求都去换。这里按 corpId+secret 缓存，
 *    提前 5 分钟过期，避免边界上刚好失效。
 *
 * 2. **错误是 HTTP 200 + errcode**。企微几乎不用 HTTP 状态码表达业务错误——
 *    删一个不存在的用户也会返回 200，body 里 errcode: 60111。所以只检查
 *    response.ok 会把所有业务失败当成成功。
 *
 * 错误码翻译：企微的错误码是 5 位数，文档里散着。这里只翻最常遇到的几个
 * （token 失效、频率超限、不在通讯录、不是好友），其余的带上 errcode 原样抛出，
 * 便于对着文档查。
 */

export type WecomCredentials = {
  corpId: string;
  agentId: string;
  secret: string;
  callbackToken?: string;
  callbackAesKey?: string;
};

const BASE = "https://qyapi.weixin.qq.com/cgi-bin";

type WecomErrorBody = { errcode?: number; errmsg?: string };

export class WecomApiError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string,
    readonly endpoint: string,
  ) {
    super(`企业微信接口 ${endpoint} 返回 ${errcode}：${describeErrcode(errcode, errmsg)}`);
    this.name = "WecomApiError";
  }
}

/** 常见错误码的中文解释。没收录的原样带出，方便对照官方文档。 */
export function describeErrcode(errcode: number, errmsg: string): string {
  switch (errcode) {
    case 0:
      return "成功";
    case 40001:
    case 42001:
      return "access_token 失效或过期，请重新连接";
    case 40013:
      return "corpId 不正确";
    case 40014:
      return "access_token 不合法";
    case 40056:
      return "AgentId 不正确";
    case 45009:
      return "接口调用超过频率限制（当日或每分上限），稍后重试或降低发送节奏";
    case 60011:
      return "没有该接口的权限，需在应用管理里勾选对应权限";
    case 60111:
      return "该成员不在通讯录里，或 userid 不对";
    case 81013:
      return "对方不是你的外部联系人，不能直接发消息";
    case 93000:
      return "不是企业微信用户，或已离职";
    default:
      return errmsg || `未知错误（errcode ${errcode}）`;
  }
}

// ---------------------------------------------------------------- token cache

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/** 提前 5 分钟当作过期，避开"刚好在边界失效"的竞态。 */
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

export function clearWecomTokenCache(corpId?: string): void {
  if (corpId) tokenCache.delete(corpId);
  else tokenCache.clear();
}

async function fetchAccessToken(credentials: WecomCredentials): Promise<string> {
  const cached = tokenCache.get(credentials.corpId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const url = `${BASE}/gettoken?corpid=${encodeURIComponent(credentials.corpId)}&corpsecret=${encodeURIComponent(credentials.secret)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const body = (await response.json().catch(() => null)) as (WecomErrorBody & { access_token?: string; expires_in?: number }) | null;
  if (!response.ok || !body) {
    throw new Error(`获取企业微信 access_token 失败（HTTP ${response.status}）`);
  }
  if (body.errcode && body.errcode !== 0) {
    throw new WecomApiError(body.errcode, body.errmsg ?? "获取 access_token 失败", "gettoken");
  }
  if (!body.access_token) throw new Error("企业微信没有返回 access_token");

  tokenCache.set(credentials.corpId, {
    token: body.access_token,
    // 企微给 7200 秒；用要它给的，减去安全余量。
    expiresAt: Date.now() + Math.max(60_000, (body.expires_in ?? 7200) * 1000 - TOKEN_SAFETY_MS),
  });
  return body.access_token;
}

// ---------------------------------------------------------------- call helper

async function callWecom<T>(
  credentials: WecomCredentials,
  endpoint: string,
  body: Record<string, unknown> | null = null,
  method: "GET" | "POST" = "POST",
): Promise<T> {
  const token = await fetchAccessToken(credentials);
  const separator = endpoint.includes("?") ? "&" : "?";
  const url = `${BASE}/${endpoint}${separator}access_token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    method,
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = (await response.json().catch(() => null)) as (WecomErrorBody & T) | null;
  if (!response.ok || !payload) {
    throw new Error(`企业微信接口 ${endpoint} 请求失败（HTTP ${response.status}）`);
  }
  // 关键：企微用 errcode 表达业务错误，HTTP 永远是 200。
  if (payload.errcode && payload.errcode !== 0) {
    throw new WecomApiError(payload.errcode, payload.errmsg ?? "", endpoint);
  }
  return payload;
}

// ---------------------------------------------------------------- sending

export type SendTextResult = { msgId: string | null };

/**
 * 给一个外部联系人（微信客户）发文本消息。
 *
 * 用的是「发消息到客户」的接口（externalcontact/add_msg_template 之外的
 * message/send）：这是应用消息，会出现在客户与企业的会话里。
 */
export async function sendTextToExternalContact(
  credentials: WecomCredentials,
  input: { externalUserId: string; text: string },
): Promise<SendTextResult> {
  const text = input.text.trim();
  if (!text) throw new Error("消息内容不能为空");
  const result = await callWecom<{ msgid?: string }>(credentials, "message/send", {
    touser: input.externalUserId,
    msgtype: "text",
    agentid: Number(credentials.agentId),
    text: { content: text },
  });
  return { msgId: result.msgid ?? null };
}

/** 给企业内部成员发文本（销售之间内部通知用）。 */
export async function sendTextToMember(
  credentials: WecomCredentials,
  input: { userId: string; text: string },
): Promise<SendTextResult> {
  const text = input.text.trim();
  if (!text) throw new Error("消息内容不能为空");
  const result = await callWecom<{ msgid?: string }>(credentials, "message/send", {
    touser: input.userId,
    msgtype: "text",
    agentid: Number(credentials.agentId),
    text: { content: text },
  });
  return { msgId: result.msgid ?? null };
}

// ---------------------------------------------------------------- contacts

export type ExternalContactInfo = {
  externalUserId: string;
  name: string | null;
  corpName: string | null;
  /** 客户主动加我们时填的备注，可能是"临安张总"这类。 */
  remark: string | null;
  /** 添加我们的成员 userid。 */
  followUserIds: string[];
};

/** 查一个外部联系人的详情（含跟进成员）。 */
export async function getExternalContact(
  credentials: WecomCredentials,
  externalUserId: string,
): Promise<ExternalContactInfo | null> {
  const result = await callWecom<{
    external_contact?: { external_userid?: string; name?: string; corp_name?: string };
    follow_user?: Array<{ userid?: string; remark?: string }>;
  }>(credentials, `externalcontact/get?external_userid=${encodeURIComponent(externalUserId)}`, null, "GET");
  if (!result.external_contact) return null;
  const follow = result.follow_user ?? [];
  return {
    externalUserId: result.external_contact.external_userid ?? externalUserId,
    name: result.external_contact.name ?? null,
    corpName: result.external_contact.corp_name ?? null,
    remark: follow.map((item) => item.remark).filter(Boolean)[0] ?? null,
    followUserIds: follow.flatMap((item) => (item.userid ? [item.userid] : [])),
  };
}

/** 列出某个成员的客户列表（用于初次同步）。 */
export async function listExternalContacts(
  credentials: WecomCredentials,
  userId: string,
): Promise<Array<{ externalUserId: string; name: string | null }>> {
  const result = await callWecom<{ external_userid?: string[]; next_cursor?: string }>(
    credentials,
    `externalcontact/list?userid=${encodeURIComponent(userId)}&limit=1000`,
    null,
    "GET",
  );
  const ids = result.external_userid ?? [];
  if (!ids.length) return [];
  // 批量详情接口最多 100 个一次。
  const details = await callWecom<{
    external_contact_list?: Array<{ external_contact?: { external_userid?: string; name?: string } }>;
  }>(credentials, "externalcontact/batch/get", {
    userid_list: [userId],
    external_userid_list: ids.slice(0, 100),
  });
  return (details.external_contact_list ?? []).flatMap((entry) => {
    const contact = entry.external_contact;
    if (!contact?.external_userid) return [];
    return [{ externalUserId: contact.external_userid, name: contact.name ?? null }];
  });
}

// ---------------------------------------------------------------- signature

/**
 * 回调 URL 校验用的签名：把 token / timestamp / nonce 排序后 SHA1。
 * 企微在配置接收 URL 时会带 echostr 来验证。
 */
export function wecomSignature(token: string, timestamp: string, nonce: string): string {
  const raw = [token, timestamp, nonce].sort().join("");
  return createHash("sha1").update(raw).digest("hex");
}

export function wecomSignatureMatches(
  token: string,
  timestamp: string,
  nonce: string,
  signature: string,
): boolean {
  return wecomSignature(token, timestamp, nonce) === signature;
}

/** 连接测试：拿到 token 就说明 corpId + secret 是对的。 */
export async function verifyWecomCredentials(credentials: WecomCredentials): Promise<void> {
  if (!credentials.corpId?.trim()) throw new Error("企业 ID 不能为空");
  if (!credentials.agentId?.trim()) throw new Error("AgentId 不能为空");
  if (!credentials.secret?.trim()) throw new Error("Secret 不能为空");
  await fetchAccessToken(credentials);
}
