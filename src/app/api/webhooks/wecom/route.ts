import { NextRequest, NextResponse } from "next/server";
import { getPlatformCredentials, listOrganizationsWithPlatform } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";
import { ingestWecomMessage } from "@/lib/wecom/inbound";
import { wecomSignatureMatches } from "@/lib/wecom/client";
import { parseFlatXml, WECOM_TEXT_TAGS } from "@/lib/wecom/xml";

/**
 * 企业微信消息回调。
 *
 * 两种请求：
 * - GET：企微配置接收 URL 时来验证，要求原样返回 echostr。
 * - POST：客户端消息推送，必须返回 "success"，否则企微会重试三次。
 *
 * 这个路由是匿名的（proxy.ts 放行），安全靠三件事：
 * 1. 签名校验：SHA1(sort(token, timestamp, nonce))——每个组织用自己的 Token 试一遍。
 * 2. 字段白名单：只认企微约定的那几个标签，别的东西直接丢。
 * 3. 幂等：同一 msgId 重复推送只进 CRM 一次。
 *
 * 加密模式（安全模式）暂不支持：明确返回 501 并记日志，而不是返回 success
 * 让企微以为送达了——那样消息会静默丢失，排查起来毫无线索。
 */

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const signature = params.get("msg_signature") ?? params.get("signature") ?? "";
  const timestamp = params.get("timestamp") ?? "";
  const nonce = params.get("nonce") ?? "";
  const echostr = params.get("echostr") ?? "";

  for (const orgId of await listOrganizationsWithPlatform("wecom")) {
    const credentials = await runInOrganization(orgId, () => getPlatformCredentials("wecom"));
    if (!credentials?.callbackToken) continue;
    if (wecomSignatureMatches(credentials.callbackToken, timestamp, nonce, signature)) {
      return new NextResponse(echostr, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
  }
  return new NextResponse("签名校验失败", { status: 401 });
}

export async function POST(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const signature = params.get("msg_signature") ?? params.get("signature") ?? "";
  const timestamp = params.get("timestamp") ?? "";
  const nonce = params.get("nonce") ?? "";
  const raw = await request.text().catch(() => "");
  if (!raw) return new NextResponse("empty body", { status: 400 });

  // 找到能验通签名的组织。
  let verified = false;
  for (const orgId of await listOrganizationsWithPlatform("wecom")) {
    const credentials = await runInOrganization(orgId, () => getPlatformCredentials("wecom"));
    if (!credentials?.callbackToken) continue;
    if (wecomSignatureMatches(credentials.callbackToken, timestamp, nonce, signature)) {
      verified = true;
      break;
    }
  }
  if (!verified) {
    console.warn("[wecom/webhook] 签名校验失败，检查回调 Token 是否与后台一致");
    return new NextResponse("签名校验失败", { status: 401 });
  }

  const fields = parseFlatXml(raw, WECOM_TEXT_TAGS);
  if (!fields) return new NextResponse("XML 解析失败", { status: 400 });

  if (fields.Encrypt) {
    console.warn("[wecom/webhook] 收到加密消息：请在企微后台把接收模式改为明文，或实现 AES 解密");
    return new NextResponse("暂不支持加密模式，请改用明文模式", { status: 501 });
  }

  // 只处理文本消息；图片与事件（加好友、关注）先忽略，不影响 CRM 主链路。
  if (fields.MsgType !== "text" || !fields.Content) {
    return new NextResponse("success", { status: 200 });
  }

  const result = await ingestWecomMessage({
    corpId: String(fields.ToUserName ?? ""),
    externalUserId: String(fields.FromUserName ?? ""),
    fromName: null,
    text: String(fields.Content),
    msgId: String(fields.MsgId ?? `${fields.CreateTime}-${fields.FromUserName}`),
    createdAt: Number(fields.CreateTime ?? Math.floor(Date.now() / 1000)),
    toUserId: null,
  });
  if (result.skipped) console.warn("[wecom/webhook] 消息未匹配到组织，已忽略");

  // 必须回 success，否则企微重试三次。
  return new NextResponse("success", { status: 200 });
}
