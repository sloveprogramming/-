import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { getMailbox } from "@/lib/outreach/mailboxes";
import { syncMailboxInboxImap } from "@/lib/outreach/imapSync";

/**
 * POST /api/outreach/mailboxes/[id]/sync — 立即收一次信（企业邮箱 IMAP）。
 *
 * 定时任务每 5 分钟扫一次；这个接口是给"刚配好邮箱，想马上确认能收到"用的，
 * 也方便排查"客户说回了但系统里没有"。
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    return await withOrgContext(req, async () => {
      const { id } = await context.params;
      const mailbox = await getMailbox(id);
      if (!mailbox) return NextResponse.json({ error: "邮箱不存在" }, { status: 404 });
      if (mailbox.provider !== "smtp") {
        return NextResponse.json({ error: "只有企业邮箱（SMTP）需要手动收信；Gmail 邮箱由推送自动同步" }, { status: 409 });
      }
      const result = await syncMailboxInboxImap(id);
      if (result.error) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
      return NextResponse.json({ ok: true, synced: result.synced });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
