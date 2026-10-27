import ByokSettingsClient from "@/components/ai/ByokSettingsClient";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "AI 服务商" };
export const dynamic = "force-dynamic";

export default function AiSettingsPage() {
  return (
    <SettingsPage title="AI 服务商" description="所有 AI 功能使用的 OpenRouter 连接与模型。">
      <ByokSettingsClient />
    </SettingsPage>
  );
}
