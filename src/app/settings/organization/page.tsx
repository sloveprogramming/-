import { ChannelRulesForm } from "@/components/settings/ChannelRulesForm";
import { OrgGeneral } from "@/components/settings/organization/OrgGeneral";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { can, requirePageOrgContext } from "@/lib/auth/context";
import { channelRulesForSettings } from "@/lib/channels/rules.server";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "组织" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const ctx = await requirePageOrgContext();
  const { values } = await runInOrganization(ctx.organizationId, () => channelRulesForSettings("general"));
  return (
    <SettingsPage title="组织" description="组织的名称、URL，以及你在其中的角色。" width="narrow">
      <div className="flex flex-col gap-8">
        <OrgGeneral />
        <section className="flex flex-col gap-3" aria-labelledby="org-defaults">
          <div>
            <h3 id="org-defaults" className="text-label-md text-text-strong-950">Defaults</h3>
            <p className="mt-1 text-paragraph-sm text-text-sub-600">所有渠道共用。</p>
          </div>
          <ChannelRulesForm channel="general" initialValues={values} canEdit={can(ctx, { integrations: ["manage"] })} />
        </section>
      </div>
    </SettingsPage>
  );
}
