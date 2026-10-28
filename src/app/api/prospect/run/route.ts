import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { runProspectPipeline, summarizeResult } from "@/lib/agent/pipeline";
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
 */
export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async (ctx) => {
      const body = (await request.json().catch(() => null)) as { product?: string } | null;
      const product = body?.product?.trim();
      if (!product) return NextResponse.json({ error: "请填写产品名" }, { status: 400 });

      const result = await runProspectPipeline({
        product,
        organizationId: ctx.organizationId,
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
        summary: summarizeResult(result),
        product: result.product,
        intent: result.intent,
        stats: result.stats,
        companies,
      });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
