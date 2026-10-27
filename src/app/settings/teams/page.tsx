import { OrgTeams } from "@/components/settings/organization/OrgTeams";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "团队" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <SettingsPage title="团队" description="把成员分成团队。" width="narrow">
      <OrgTeams />
    </SettingsPage>
  );
}
