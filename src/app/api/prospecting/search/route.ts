import { NextRequest, NextResponse } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { searchCompanies } from "@/lib/qcc/provider";

/**
 * GET /api/prospecting/search?q=关键词&source=auto|local|qcc
 *
 * 配置了企查查就搜全国，没配置就搜本地线索库；两者共用一种结果形状。
 */
export async function GET(request: NextRequest) {
  try {
    return await withOrgContext(request, async () => {
      const q = request.nextUrl.searchParams.get("q") ?? "";
      const sourceParam = request.nextUrl.searchParams.get("source");
      const source = sourceParam === "local" || sourceParam === "qcc" ? sourceParam : "auto";
      const result = await searchCompanies(q, { source });
      return NextResponse.json(result);
    });
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
