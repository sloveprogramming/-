import AddMailboxButton from "@/components/outreach/AddMailboxButton";
import MailboxesPageClient from "@/components/outreach/MailboxesPageClient";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listMailboxes } from "@/lib/outreach/mailboxes";

export const dynamic = "force-dynamic";

export const metadata = { title: "发信邮箱" };

/**
 * 改造：这一页不再要求先连 Google Workspace。
 * 企业邮箱（SMTP）自带凭据，连上就能发；Google Workspace 只是其中一个选项。
 */

async function Mailboxes() {
  const ctx = await requirePageOrgContext();
  const mailboxes = await runInOrganization(ctx.organizationId, () => listMailboxes());
  return <MailboxesPageClient mailboxes={mailboxes} />;
}

export default function EmailAccountsPage() {
  return (
    <SettingsPage
      title="发信邮箱"
      description="外发活动和 CRM 回复都从这里的邮箱发出。国内建议用企业邮箱（SMTP）。"
      actions={<AddMailboxButton />}
    >
      <Mailboxes />
    </SettingsPage>
  );
}
