import type { Metadata } from "next";
import { SettingsShell } from "@/components/settings/SettingsShell";

export const metadata: Metadata = {
  title: {
    default: "设置 · 新农哥拓客",
    template: "%s · 设置 · 新农哥拓客",
  },
};

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return <SettingsShell>{children}</SettingsShell>;
}
