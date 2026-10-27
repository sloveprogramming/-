import { VisitsClient } from "@/components/crm/VisitsClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { listVisits } from "@/lib/crm/visits";
import { runInOrganization } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";
export const metadata = { title: "拜访" };

/**
 * 拜访页：待拜访 / 已结束两段。
 *
 * 改造新增。之前系统里"见客户"这件事只体现为把记录的阶段改成「已见面」，
 * 没有时间、地点、纪要，也没法看"这周我要去见谁"。
 */
export default async function VisitsPage() {
  const ctx = await requirePageOrgContext();
  const visits = await runInOrganization(ctx.organizationId, () => listVisits({ limit: 200 }));
  return <VisitsClient initialVisits={visits} />;
}
