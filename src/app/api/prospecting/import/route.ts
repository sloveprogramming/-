import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { importCompanies } from "@/lib/qcc/provider";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * POST /api/prospecting/import — 把搜索结果加入线索库。
 *
 * body: { hits: CompanyHit[] }（界面上勾选的那几条，原样回传）
 * 只建公司，不硬造联系人；重复的公司会被跳过。
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
      let body: { hits?: unknown };
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
      }
      if (!Array.isArray(body.hits)) {
        return NextResponse.json({ error: "hits 必须是数组" }, { status: 400 });
      }
      const hits = body.hits.map(asHit).filter((hit): hit is CompanyHit => hit !== null);
      if (!hits.length) return NextResponse.json({ error: "没有可导入的公司" }, { status: 400 });
      const result = await importCompanies(hits);
      return NextResponse.json({ ok: true, ...result });
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
