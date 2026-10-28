import { PhoneWorkbenchClient } from "@/components/prospecting/PhoneWorkbenchClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { qccConfigured } from "@/lib/qcc/client";

export const dynamic = "force-dynamic";
export const metadata = { title: "电话名单" };

/**
 * 电话名单：产品 → 买家画像 → 公司电话 → 通话话术。
 *
 * 改造新增。切入点是销售拿到新产品时的真实困境：知道要卖什么，但不知道
 * 卖给谁、去哪儿找、第一句说什么。
 *
 * 这一页刻意不做外呼：国内 AI 外呼需要运营商资质与服务商账号，先把
 * "人在打电话"这一侧跑通，比接一堆发不出去的 API 有用。
 */
export default async function PhoneWorkbenchPage() {
  const ctx = await requirePageOrgContext();
  return <PhoneWorkbenchClient qccEnabled={qccConfigured()} repName={ctx.userName || null} />;
}
