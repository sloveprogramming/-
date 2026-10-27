import { OrgMembers } from "@/components/settings/organization/OrgMembers";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "成员" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <SettingsPage title="成员" description="邀请成员，并管理各自的权限。" width="narrow">
      <OrgMembers />
    </SettingsPage>
  );
}
