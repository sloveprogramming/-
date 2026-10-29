import type { NextRequest } from "next/server";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { assertExactKeys, assertObject, parseOptionalText, parseUuid, readCrmJson } from "@/lib/crm/categories";
import { regenerateDraft } from "@/lib/crm/drafts";
import { requireCrmMutationContext } from "@/lib/crm/http";
import { runInOrganization } from "@/lib/tenancy/scope";
import { chunkTextForStreaming, createSseResponse } from "@/lib/agent/stream";

/**
 * POST /api/crm/drafts/[id]/regenerate/stream
 *
 * 和 `/regenerate` 做同一件事，但用 SSE 把文本按句推给前端，让销售看到
 * "AI 正在写"而不是白屏等十秒。
 *
 * 为什么另开一个路由而不是改原来的：
 * - 原来的接口是给"后台重生成"用的（比如 worker），它需要 JSON 响应
 * - 流式接口是一次性的 UI 交互，语义不同
 * - 保留两者，前端按场景选
 *
 * ## 关于"真流式"与"假流式"
 *
 * 这里实现的是**假流式**：先等 `regenerateDraft` 完整跑完，再按句把结果推出去。
 *
 * 真流式需要模型侧的 token 级回调，而当前链路是
 * `regenerateDraft → generateCrmDraft → completeStructuredWithOpenRouter`，
 * 每一层都是一次性返回（而且是 tool_choice 强制结构化输出，根本没有流式文本）。
 *
 * 为什么还是值得做：对销售来说，"看着字一个个出来"和"等 10 秒突然出现"
 * 的体感差别很大，而且假流式的实现成本几乎为零、不影响任何现有逻辑。
 * 真要上真流式，得改结构化输出那一层——那是另一件事。
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireCrmMutationContext(request);
    const draftId = parseUuid((await params).id, "draft id");

    const value = await readCrmJson(request).catch(() => ({}));
    assertObject(value);
    assertExactKeys(value, ["feedback"]);
    const feedback = parseOptionalText(value.feedback, "feedback", 4_000) ?? null;

    return createSseResponse(request, async (send, signal) => {
      // 组织作用域要在流内部建立：外面建立的话，async 执行已经脱离作用域了。
      const draft = await runInOrganization(ctx.organizationId, async () => {
        if (signal.aborted) throw new Error("客户端已取消");
        return regenerateDraft(draftId, {}, feedback);
      });

      const body = draft.aiBodyText ?? draft.editedBodyText ?? "";
      const subject = draft.subject ?? "";

      // 先推主题，让用户知道这封信在说什么。
      if (subject) send({ type: "delta", text: `主题：${subject}\n\n` });

      // 按句推送，每句之间留一点间隔——真实网络下这个间隔会被传输延迟自然吸收，
      // 本地开发时给个很小的延迟，避免瞬间刷完看不出"流"的效果。
      for (const piece of chunkTextForStreaming(body)) {
        if (signal.aborted) return;
        send({ type: "delta", text: piece });
        await new Promise((resolve) => setTimeout(resolve, 12));
      }

      send({ type: "done", text: body });
    });
  } catch (error) {
    // 建流之前就失败（鉴权、参数）——这时还没进入 SSE，正常返回 JSON 错误。
    return crmOperationErrorResponse(error);
  }
}
