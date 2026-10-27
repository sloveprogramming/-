import { RulesSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "企业微信发送规则" };
export const dynamic = "force-dynamic";

/**
 * 企业微信的发送规则。
 *
 * 规则本身定义在 lib/channels/rules.ts 的 CHANNEL_RULES.wecom 里（加好友上限、
 * 两条消息间隔、发送时段、自动跟进间隔），这个页面只是把它们渲染成表单。
 */
export default function Page() {
  return (
    <RulesSettingsPage
      channel="wecom"
      title="企业微信发送规则"
      description="加好友频率、消息间隔和发送时段。企微对主动加好友有风控，宁可按周慢慢加，也不要一天加满。"
    />
  );
}
