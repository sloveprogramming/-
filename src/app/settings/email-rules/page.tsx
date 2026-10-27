import { RulesSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "发信规则" };
export const dynamic = "force-dynamic";

export default function Page() {
  return <RulesSettingsPage channel="email" title="发信规则" description="邮箱的发送速度与时段。默认值适合已预热的 Google Workspace 邮箱；不清楚发信信誉的话建议别改。" />;
}
