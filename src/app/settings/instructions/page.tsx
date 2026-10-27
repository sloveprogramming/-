import { SettingsPage } from "@/components/settings/SettingsPage";
import InstructionsSettings from "@/components/settings/InstructionsSettings";

export const metadata = { title: "运营指令" };
export const dynamic = "force-dynamic";

export default function InstructionsPage() {
  return (
    <SettingsPage
      title="Instructions"
      description="附加到每次 AI 起草与分类的指引。每条指令都会作为独立小节发给 AI。"
    >
      <InstructionsSettings />
    </SettingsPage>
  );
}
