import { NextRequest, NextResponse } from "next/server";
import { listMailboxes, connectMailbox, connectSmtpMailbox } from "@/lib/outreach/mailboxes";
import { withOrgContext, authContextErrorResponse } from "@/lib/auth/context";

// GET /api/outreach/mailboxes — list connected mailboxes.
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const rows = await listMailboxes();
      return NextResponse.json({ mailboxes: rows });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

// POST /api/outreach/mailboxes — connect a mailbox: { emailAddress, displayName?, signatureHtml? }
// 改造：一个接口接两种邮箱。
//   - 不带 provider（或 "gmail"）：老路径，只报地址，验证服务账号能不能冒充它。
//   - provider: "smtp"：企业邮箱，带 host/port/secure/user/secret，入库前先真登一次。
export async function POST(req: NextRequest) {
  try {
    return await withOrgContext(req, async () => {
      let body: {
        provider?: string;
        emailAddress?: string;
        displayName?: string;
        signatureHtml?: string;
        host?: string;
        port?: number;
        secure?: boolean;
        user?: string;
        secret?: string;
      };
      try {
        body = await req.json();
      } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
      }

      if (!body.emailAddress) {
        return NextResponse.json({ error: "emailAddress is required" }, { status: 400 });
      }

      const result = body.provider === "smtp"
        ? await connectSmtpMailbox({
            emailAddress: body.emailAddress,
            displayName: body.displayName,
            signatureHtml: body.signatureHtml,
            host: body.host ?? "",
            port: Number(body.port ?? 465),
            secure: body.secure ?? true,
            user: body.user ?? body.emailAddress,
            secret: body.secret ?? "",
          })
        : await connectMailbox({
            emailAddress: body.emailAddress,
            displayName: body.displayName,
            signatureHtml: body.signatureHtml,
          });
      if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
      }
      return NextResponse.json(result, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
