import { ProspectingClient } from "@/components/prospecting/ProspectingClient";
import { requirePageOrgContext } from "@/lib/auth/context";
import { ICP_KEYWORDS } from "@/lib/icp/segments";
import { qccConfigured } from "@/lib/qcc/client";

export const dynamic = "force-dynamic";

export const metadata = { title: "找客户" };

/**
 * 找客户：搜索企业并加入线索库。
 *
 * 数据源在服务端决定（企查查或本地库），页面只负责展示与选择。
 * 关键词标签直接来自 ICP 常量——搜索口径和客户画像用同一份数据，不会漂。
 */
export default async function ProspectingPage() {
  await requirePageOrgContext();
  const keywordGroups = [
    { label: "行业", words: ICP_KEYWORDS.industry.slice(0, 8) },
    { label: "渠道", words: ICP_KEYWORDS.channel.slice(0, 8) },
  ];
  return <ProspectingClient keywordGroups={keywordGroups} qccEnabled={qccConfigured()} />;
}
