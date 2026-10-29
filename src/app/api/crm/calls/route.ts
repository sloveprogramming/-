import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { listRecordCalls, logCall, recordsWithCallIntent } from "@/lib/crm/calls";
import type { CallIntent, CallOutcome } from "@/lib/crm/callTypes";

/**
 * /api/crm/calls —— 通话结果的读写。
 *
 * GET  ?recordId=xxx   这条记录的通话历史
 * GET  （无参数）      有通话意向的记录（销售每天开工先看这个）
 * POST                 记一次通话
 *
 * 放在 /api/crm 下而不是 /api/calls：项目里已经有一个 `lib/calls`（WhatsApp
 * 录音那套，未启用），同名的 API 路由会让人以为是同一件事。
 */
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const recordId = request.nextUrl.searchParams.get("recordId");
      if (recordId) {
        return NextResponse.json({ calls: await listRecordCalls(recordId) });
      }
      return NextResponse.json({ records: await recordsWithCallIntent() });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    return crmOperationErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const body = (await request.json().catch(() => null)) as {
        recordId?: string;
        outcome?: CallOutcome;
        intent?: CallIntent;
        notes?: string;
        nextStep?: string;
        durationSeconds?: number;
        contactName?: string;
      } | null;
      if (!body?.recordId) return NextResponse.json({ error: "recordId 是必填的" }, { status: 400 });
      if (!body.outcome) return NextResponse.json({ error: "请选择通话结果" }, { status: 400 });
      if (!body.intent) return NextResponse.json({ error: "请选择意向判断" }, { status: 400 });

      const call = await logCall({
        recordId: body.recordId,
        outcome: body.outcome,
        intent: body.intent,
        notes: body.notes,
        nextStep: body.nextStep,
        durationSeconds: body.durationSeconds,
        contactName: body.contactName,
      });
      return NextResponse.json({ ok: true, call }, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    return crmOperationErrorResponse(error);
  }
}
