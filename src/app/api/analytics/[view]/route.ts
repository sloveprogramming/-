import type { NextRequest } from "next/server";
import { authContextErrorResponse, withOrgContext } from "@/lib/auth/context";
import { ANALYTICS_VIEWS, type AnalyticsRange, type AnalyticsResponse, type AnalyticsView } from "@/lib/analytics/contract";
import { getEmailAnalytics } from "@/lib/analytics/email.server";
import { getOverviewAnalytics } from "@/lib/analytics/overview.server";
import { AnalyticsRangeError, parseAnalyticsRange } from "@/lib/analytics/server";

export const dynamic = "force-dynamic";

// 改造：linkedin / whatsapp 两个视图随频道删除，只剩总览与邮件。
const LOADERS: Record<AnalyticsView, (range: AnalyticsRange) => Promise<AnalyticsResponse>> = {
  overview: getOverviewAnalytics,
  email: getEmailAnalytics,
};

/**
 * GET /api/analytics/{overview|email}?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City
 * Behind the site auth like every other /api route (src/proxy.ts).
 */
export async function GET(request: NextRequest, context: { params: Promise<{ view: string }> }) {
  const { view } = await context.params;
  if (!(ANALYTICS_VIEWS as readonly string[]).includes(view)) {
    return Response.json({ error: `Unknown analytics view: ${view}` }, { status: 404 });
  }
  try {
    const range = parseAnalyticsRange(request.nextUrl.searchParams);
    return await withOrgContext(request, async () => Response.json(await LOADERS[view as AnalyticsView](range)));
  } catch (error) {
    const denied = authContextErrorResponse(error);
    if (denied) return denied;
    if (error instanceof AnalyticsRangeError) return Response.json({ error: error.message }, { status: 400 });
    console.error(`[analytics:${view}]`, error);
    return Response.json({ error: "Could not load analytics" }, { status: 500 });
  }
}
