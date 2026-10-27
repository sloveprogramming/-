import ColumnSettings from "@/components/leads/ColumnSettings";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listColumns } from "@/lib/leads/columns";

export const metadata = { title: "线索字段" };
export const dynamic = "force-dynamic";

/**
 * The column settings screen — the fields available on People and Companies.
 *
 * Reads the registry directly rather than through /api/leads/columns: this is
 * a server component, and a server component fetching its own API costs a
 * round-trip to render what it could have queried.
 *
 * Archived columns are included so the "Removed columns" section and the
 * Postgres column budget can both account for them — an archived column is
 * hidden from the app but still physically present on the table.
 */
export default async function LeadColumnSettingsPage() {
  const ctx = await requirePageOrgContext();
  const columns = await runInOrganization(ctx.organizationId, () => listColumns(undefined, { includeArchived: true }));

  return (
    <SettingsPage title="线索字段" description="联系人与公司的字段，包括你自己添加的。">
      <ColumnSettings columns={columns} />
    </SettingsPage>
  );
}
