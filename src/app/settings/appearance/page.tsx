import AppearanceSettings from "@/components/settings/AppearanceSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "外观" };

export default function AppearancePage() {
  return (
    <SettingsPage title="外观" description="浅色、深色，或跟随系统。" width="narrow">
      <AppearanceSettings />
    </SettingsPage>
  );
}
