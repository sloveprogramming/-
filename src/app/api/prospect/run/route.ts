import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { runProspectPipeline, summarizeResult } from "@/lib/agent/pipeline";
import { createArtifactRecorder } from "@/lib/agent/artifactStore";
import {
  callPythonProspect,
  ProspectBackendConfigError,
  resolveProspectBackendConfig,
} from "@/lib/agent/backendRouting";
import { buildCallScript, renderCallScriptText } from "@/lib/icp/callScript";

/**
 * POST /api/prospect/run   { product: "面包丝" }
 *
 * 一次跑完四段：产品解析 → 检索 → 初筛 → 联系方式。
 *
 * 为什么用 POST 而不是 GET：这是一次可能耗时十几秒的操作（多个关键词搜索 +
 * 可能的模型调用），不该被浏览器或代理缓存。而且它没有"幂等可重放"的语义——
 * 每次跑都可能因为上游数据变化给不同结果。
 *
 * 返回里带每个可打公司的**话术摘要**，让前端不用再算一遍。
 *
 * 每一段的产物都会落进 `agent_artifacts`（按 traceId 聚合），响应里回传
 * `traceId`，便于事后查"这次到底产出了什么、哪一步慢了"。
 */
export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async (ctx) => {
      const body = (await request.json().catch(() => null)) as { product?: string } | null;
      const product = body?.product?.trim();
      if (!product) return NextResponse.json({ error: "请填写产品名" }, { status: 400 });

      const backend = resolveProspectBackendConfig();
      if (backend.kind === "python") {
        const result = await callPythonProspect({
          baseUrl: backend.baseUrl,
          token: backend.token,
          product,
          organizationId: ctx.organizationId,
          userName: ctx.userName,
        });
        if (!result.ok) {
          return NextResponse.json(
            { error: result.message, code: result.code },
            { status: result.status },
          );
        }
        return NextResponse.json(result.payload);
      }

      const traceId = crypto.randomUUID();
      const result = await runProspectPipeline({
        product,
        organizationId: ctx.organizationId,
        traceId,
        deps: {
          recordArtifact: createArtifactRecorder({
            organizationId: ctx.organizationId,
            traceId,
          }),
        },
      });

      // 给每家公司附上电话话术：销售点开就能用，不用再发起一次请求。
      const companies = result.companies.map((company) => {
        const script = buildCallScript({
          product: result.intent,
          companyName: company.hit.name,
          contactName: null,
          repName: ctx.userName || null,
        });
        return {
          ...company,
          // 只回渲染好的纯文本，避免把整个话术结构塞进响应。
          scriptText: company.reachable ? renderCallScriptText(script, { rep: ctx.userName || null }) : null,
        };
      });

      return NextResponse.json({
        ok: true,
        traceId: result.traceId,
        summary: summarizeResult(result),
        product: result.product,
        intent: result.intent,
        stats: result.stats,
        // 换词重搜的记录：界面要告诉销售"名单是怎么来的"，尤其是"换过词"这件事。
        replan: result.replan,
        companies,
        warnings: [],
      });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    if (error instanceof ProspectBackendConfigError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 503 },
      );
    }
    throw error;
  }
}
