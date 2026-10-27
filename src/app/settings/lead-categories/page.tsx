import { SettingsPage } from "@/components/settings/SettingsPage";
import CrmSettingsClient from "@/components/crm/CrmSettingsClient";

export const metadata = { title: "线索分类" };
export const dynamic = "force-dynamic";

export default function LeadCategoriesPage() {
  return (
    <SettingsPage
      title="线索分类"
      description="AI 把回复归入的子分类，以及每个子分类对应的回复序列。"
    >
      <CrmSettingsClient />
    </SettingsPage>
  );
}
