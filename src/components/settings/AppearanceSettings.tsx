"use client";

import { RiMoonLine, RiSunLine } from "@remixicon/react";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useTheme } from "@/components/theme/ThemeProvider";
import { ThemeSwitch } from "@/components/theme/ThemeSwitch";
import { FieldRow } from "./SettingsKit";

const SHOWING = {
  light: { label: "Light", icon: RiSunLine },
  dark: { label: "Dark", icon: RiMoonLine },
} as const;

/** The Appearance section: the Light / Dark / System switch and what it is doing right now. */
export default function AppearanceSettings() {
  const { preference, resolved } = useTheme();
  const Showing = SHOWING[resolved].icon;

  return (
    <Frame>
      <FrameHeader title="Theme" description="新农哥拓客在这个浏览器里的外观。" />
      <FramePanel>
        <FieldRow
          label="配色主题"
          description="跟随系统会根据电脑的浅色/深色设置自动切换。"
        >
          <ThemeSwitch className="w-full" />
          {preference === "system" && (
            <p className="mt-2 flex items-center gap-1.5 text-paragraph-xs text-text-sub-600">
              <Showing className="size-3.5 shrink-0 text-text-soft-400" aria-hidden="true" />
              Showing {SHOWING[resolved].label.toLowerCase()}, from your system setting
            </p>
          )}
        </FieldRow>
      </FramePanel>
      <FrameFooter>
        只在这个浏览器里记住。其他浏览器和设备各有各的选择，也不会保存到你的工作区。
      </FrameFooter>
    </Frame>
  );
}
