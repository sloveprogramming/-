import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { crmOperationErrorResponse } from "@/lib/crm/api";
import { promoteCompaniesToCrm } from "@/lib/qcc/promote";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * POST /api/prospect/promote —— 把拓客名单上的公司加进 CRM。
 *
 * body: { hits: CompanyHit[] }
 *
 * 与 /api/prospecting/import 的区别：
 *   import  只建公司（"我先把这批存起来"）
 *   promote 建公司 + 临时联系人 + CRM 记录（"我要现在开始跟这家"）
 *
 * 两者都保留：批量囤线索用前者，决定跟进了用后者。
 *
 * 返回每个成功项带 recordId，前端可以直接跳到记录页。
 */
function asHit(value: unknown): CompanyHit | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  const text = (input: unknown): string | null => (typeof input === "string" && input.trim() ? input.trim() : null);
  return {
    key: typeof row.key === "string" ? row.key : name,
    name,
    creditCode: text(row.creditCode),
    region: text(row.region),
    industry: text(row.industry),
    legalPerson: text(row.legalPerson),
    foundedAt: text(row.foundedAt),
    registeredCapital: text(row.registeredCapital),
    phones: Array.isArray(row.phones) ? row.phones.filter((p): p is string => typeof p === "string") : [],
    scope: text(row.scope),
    status: text(row.status),
    inLibrary: false,
  };
}

export async function POST(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const body = (await request.json().catch(() => null)) as { hits?: unknown } | null;
      if (!body || !Array.isArray(body.hits)) {
        return NextResponse.json({ error: "hits 必须是数组" }, { status: 400 });
      }
      const hits = body.hits.map(asHit).filter((hit): hit is CompanyHit => hit !== null);
      if (!hits.length) return NextResponse.json({ error: "没有可加入的公司" }, { status: 400 });

      const result = await promoteCompaniesToCrm(hits);
      return NextResponse.json({
        ok: true,
        promoted: result.results,
        failed: result.failed,
      });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    return crmOperationErrorResponse(error);
  }
}
