import { ProspectRunClient } from "@/components/prospecting/ProspectRunClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { qccConfigured } from "@/lib/qcc/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "产品拓客" };

/**
 * 产品拓客：一次跑完四个 Agent。
 *
 * 与 /phone 的区别：/phone 是"给一家公司一份话术"的工作台（人工逐个看），
 * 这里是从一个产品出发**批量出名单**的入口。两者共用同一套评估与话术逻辑，
 * 只是入口不同——销售想批量扫的时候用这个，想逐个打的时候用那个。
 */
export default async function ProspectPage() {
  await requirePageOrgContext();
  return <ProspectRunClient qccEnabled={qccConfigured()} />;
}
