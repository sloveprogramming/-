import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "邮箱连接" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <ConnectionSettingsPage
      platforms={[{ platform: "google" }]}
      comingSoon={[
        {
          name: "Microsoft Outlook",
          description: "通过 Microsoft Azure 连接 Microsoft 365 与 Outlook 邮箱收发邮件。",
          iconUrl: "/Integrations - Icon/microsoft.svg",
          enables: ["Outlook mailboxes", "email campaigns", "inbox sync"],
        },
      ]}
      title="邮箱连接"
      description="Google Workspace 服务账号，为「邮件 → 发信邮箱」里的每个邮箱收发 Gmail。Microsoft Outlook 即将支持。"
    />
  );
}
