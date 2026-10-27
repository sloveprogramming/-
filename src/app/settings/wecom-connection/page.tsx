import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "企业微信连接" };
export const dynamic = "force-dynamic";

/**
 * 企业微信连接配置。
 *
 * 改造新增：原来这里（以及整个设置）只有 Google Workspace / Unipile / R2。
 * 企微是国内 B2B 的主渠道，接好之后「加好友 → 聊天 → 客户回复进 CRM」这条
 * 主链路才通。
 */
export default function Page() {
  return (
    <ConnectionSettingsPage
      platforms={[{ platform: "wecom" }]}
      comingSoon={[
        {
          name: "企业微信服务商模式",
          description: "用第三方服务商代管多个企业的企微（适合代理商/代运营场景）。现在是自建应用模式，单企业够用。",
          iconUrl: "/Integrations - Icon/wecom.svg",
          enables: ["多企业托管", "代运营场景"],
        },
      ]}
      title="企业微信连接"
      description="企业微信自建应用：填企业 ID、AgentId 和 Secret 后，就能给客户发消息、把客户回复收进 CRM。"
    />
  );
}
