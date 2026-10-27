import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { cancelVisit, checkInVisit, completeVisit, listVisits, planVisit, VISIT_OUTCOME_LABEL } from "@/lib/crm/visits";

/**
 * /api/visits —— 拜访的增查与状态流转。
 *
 * GET  列表（可选 from / to）
 * POST 安排一次拜访   { recordId, scheduledAt, location?, purpose? }
 * PATCH 推进状态       { visitId, action: "check_in" | "complete" | "cancel", ... }
 *
 * 状态流转放在一个接口里，因为它们的校验规则是同一套状态机（visits.ts）；
 * 拆成三个路由只会让"允许哪些流转"这份知识散落在三处。
 */

export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const from = request.nextUrl.searchParams.get("from") ?? undefined;
      const to = request.nextUrl.searchParams.get("to") ?? undefined;
      return NextResponse.json({ visits: await listVisits({ from, to }) });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    // 拜访的状态流转冲突（例如"结束后不能再签到"）要变成 409，而不是 500。
    return crmOperationErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const body = (await request.json().catch(() => null)) as {
        recordId?: string;
        scheduledAt?: string;
        location?: string;
        purpose?: string;
      } | null;
      if (!body?.recordId) return NextResponse.json({ error: "recordId 是必填的" }, { status: 400 });
      if (!body.scheduledAt) return NextResponse.json({ error: "拜访时间是必填的" }, { status: 400 });
      const result = await planVisit({
        recordId: body.recordId,
        scheduledAt: body.scheduledAt,
        location: body.location,
        purpose: body.purpose,
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    // 拜访的状态流转冲突（例如"结束后不能再签到"）要变成 409，而不是 500。
    return crmOperationErrorResponse(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const body = (await request.json().catch(() => null)) as {
        visitId?: string;
        action?: "check_in" | "complete" | "cancel";
        notes?: string;
        nextStep?: string;
        outcome?: keyof typeof VISIT_OUTCOME_LABEL;
        reason?: string;
      } | null;
      if (!body?.visitId) return NextResponse.json({ error: "visitId 是必填的" }, { status: 400 });

      switch (body.action) {
        case "check_in":
          await checkInVisit(body.visitId);
          return NextResponse.json({ ok: true, status: "checked_in" });
        case "complete": {
          if (!body.outcome) return NextResponse.json({ error: "结束拜访要选结果" }, { status: 400 });
          await completeVisit({
            visitId: body.visitId,
            notes: body.notes ?? "",
            nextStep: body.nextStep,
            outcome: body.outcome,
          });
          return NextResponse.json({ ok: true, status: "completed" });
        }
        case "cancel":
          await cancelVisit(body.visitId, body.reason ?? "");
          return NextResponse.json({ ok: true, status: "cancelled" });
        default:
          return NextResponse.json({ error: "action 必须是 check_in / complete / cancel" }, { status: 400 });
      }
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    // 拜访的状态流转冲突（例如"结束后不能再签到"）要变成 409，而不是 500。
    return crmOperationErrorResponse(error);
  }
}
