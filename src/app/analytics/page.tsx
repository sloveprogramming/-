import AnalyticsClient from "@/components/analytics/AnalyticsClient";
import { parseView } from "@/components/analytics/range";

export const dynamic = "force-dynamic";
export const metadata = { title: "数据分析" };

type Search = Promise<{ view?: string | string[]; range?: string | string[] }>;

export default async function AnalyticsPage({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const view = parseView(first(params.view));
  const range = first(params.range);
  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <AnalyticsClient initialView={view} initialRange={range ?? "30d"} />
    </div>
  );
}
