import type { Metadata } from "next";
import { connection } from "next/server";
import AppShell from "@/components/AppShell";
import DialogProvider from "@/components/DialogProvider";
import { DemoProvider } from "@/components/demo/DemoProvider";
import { THEME_INIT_SCRIPT, ThemeProvider } from "@/components/theme/ThemeProvider";
import { isDemoMode } from "@/lib/demo/mode";
import "./globals.css";

// 中文化：字体不再从 next/font/google 拉取（Google Fonts 在国内构建时会超时，
// 而且 Inter/Geist 没有中文字形）。字体栈定义在 globals.css 的 @theme 里，
// 用系统中文字体，零下载。

export const metadata: Metadata = {
  title: "新农哥拓客",
  // A private workspace behind sign-in: keep every page out of search.
  robots: { index: false, follow: false },
  description: "新农哥的智能拓客与客户管理系统",
  // The favicon is src/app/icon.svg and apple-icon.png (Next's file convention):
  // the brand tile, which reads on light and dark tabs alike.
};

export default async function RootLayout({
  children,
  modal,
}: Readonly<{
  children: React.ReactNode;
  /** Pop-ups with their own URL — today only Settings (src/app/@modal). */
  modal: React.ReactNode;
}>) {
  // DEMO_MODE is a runtime setting of the deployment, not of the build: read
  // it per request, never baked into a prerendered page.
  await connection();
  const demo = isDemoMode();

  // Theme: data-theme="light" is the server default. THEME_INIT_SCRIPT runs
  // before paint and switches <html> to the stored choice (light, dark, or the
  // OS preference) — the `.dark` token block in globals.css does the rest —
  // and ThemeProvider keeps it in sync after hydration. data-theme also stops
  // the OS-preference dark block from applying on its own.
  //
  // suppressHydrationWarning: that script, and the call-recorder extension
  // (data-agentsdr-recorder, RECORDER_INSTALLED_ATTRIBUTE in
  // src/lib/calls/contract.ts), change <html> attributes before React loads.
  // It covers this element's own attributes only, not its children.
  return (
    <html
      lang="zh-CN"
      data-theme="light"
      suppressHydrationWarning
      className="h-full antialiased"
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col bg-bg-white-0 text-text-strong-950">
        <ThemeProvider>
          <DialogProvider>
            <DemoProvider enabled={demo}>
              <AppShell>{children}</AppShell>
              {modal}
            </DemoProvider>
          </DialogProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
