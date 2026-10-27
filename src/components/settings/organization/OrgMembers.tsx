"use client";

import { useState, type FormEvent } from "react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { authClient } from "@/lib/auth/client";
import { ROLE_LABELS, type OrgRole } from "@/lib/auth/permissions";
import { asOrgRole, useAsyncAction, useOrgAccess } from "./useOrgAccess";

const date = (d: Date | string) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function OrgMembers() {
  const { org, role, userId, loading, error: loadError, reload, can } = useOrgAccess();
  const dialogs = useDialogs();
  const { busy, error, setError, run } = useAsyncAction();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");
  const [copied, setCopied] = useState<string | null>(null);

  if (loading) return <p className="text-paragraph-sm text-text-sub-600">加载中…</p>;
  if (!org || !role) return <Callout tone="error">{loadError || "No active organization."}</Callout>;

  const isOwner = role === "owner";
  const canInvite = can({ invitation: ["create"] });
  const canCancel = can({ invitation: ["cancel"] });
  const canUpdate = can({ member: ["update"] });
  const canRemove = can({ member: ["delete"] });
  const owners = org.members.filter((m) => m.role === "owner").length;
  const pending = org.invitations.filter((i) => i.status === "pending");
  const assignable: OrgRole[] = isOwner ? ["member", "admin", "owner"] : ["member", "admin"];

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!org || !email.trim()) return;
    const ok = await run("invite", () =>
      authClient.organization.inviteMember({ email: email.trim(), role: inviteRole, organizationId: org.id }),
    );
    if (ok) {
      setEmail("");
      await reload();
    }
  }

  async function cancelInvite(id: string) {
    const ok = await run(`cancel-${id}`, () => authClient.organization.cancelInvitation({ invitationId: id }));
    if (ok) await reload();
  }

  async function copyLink(id: string) {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/accept-invitation/${id}`);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      setError("Could not copy. Select the link manually: /accept-invitation/" + id);
    }
  }

  async function changeRole(memberId: string, newRole: OrgRole) {
    if (!org) return;
    const ok = await run(`role-${memberId}`, () =>
      authClient.organization.updateMemberRole({ memberId, role: newRole, organizationId: org.id }),
    );
    await reload();
    return ok;
  }

  async function removeMember(memberId: string, label: string) {
    if (!org) return;
    const confirmed = await dialogs.confirm({
      title: `Remove ${label}?`,
      description: `They lose access to ${org.name} immediately.`,
      confirmLabel: "Remove",
      variant: "error",
    });
    if (!confirmed) return;
    const ok = await run(`remove-${memberId}`, () =>
      authClient.organization.removeMember({ memberIdOrEmail: memberId, organizationId: org.id }),
    );
    if (ok) await reload();
  }

  return (
    <div className="flex flex-col gap-6">
      {error && <Callout tone="error">{error}</Callout>}

      {canInvite && (
        <Frame>
          <FrameHeader title="Invite someone" description="They get an email with a link to join this organization." />
          <FramePanel>
            <form onSubmit={invite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Email" htmlFor="invite-email" className="flex-1">
                <Input.Root size="small">
                  <Input.Wrapper>
                    <Input.Input id="invite-email" type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </Input.Wrapper>
                </Input.Root>
              </Field>
              <Field label="Role" className="sm:w-40">
                <Select.Root size="small" value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
                  <Select.Trigger aria-label="Role">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Content>
                    {assignable.map((r) => (
                      <Select.Item key={r} value={r}>{ROLE_LABELS[r]}</Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
              </Field>
              <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={busy === "invite"}>
                {busy === "invite" ? "Sending…" : "Send invite"}
              </Button.Root>
            </form>
          </FramePanel>
        </Frame>
      )}

      {pending.length > 0 && (
        <Frame>
          <FrameHeader title="Pending invitations" description="Where no email service is set up, copy the link and send it yourself." />
          <FramePanel className="divide-y divide-stroke-soft-200 py-0 sm:py-0">
            {pending.map((inv) => (
              <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-label-sm text-text-strong-950">{inv.email}</p>
                  <p className="text-paragraph-xs text-text-sub-600">
                    {ROLE_LABELS[asOrgRole(inv.role)]} · expires {date(inv.expiresAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void copyLink(inv.id)}>
                    {copied === inv.id ? "Copied" : "Copy invite link"}
                  </Button.Root>
                  {canCancel && (
                    <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy === `cancel-${inv.id}`} onClick={() => void cancelInvite(inv.id)}>
                      Cancel
                    </Button.Root>
                  )}
                </div>
              </div>
            ))}
          </FramePanel>
        </Frame>
      )}

      <Frame>
        <FrameHeader title="Members" description={`${org.members.length} in ${org.name}`} />
        <FramePanel className="divide-y divide-stroke-soft-200 py-0 sm:py-0">
          {org.members.map((m) => {
            const mRole = asOrgRole(m.role);
            const isSelf = m.userId === userId;
            const lastOwner = mRole === "owner" && owners <= 1;
            // Only an owner may touch an owner; nobody may change the last one.
            const editable = (canUpdate || canRemove) && !isSelf && !lastOwner && (isOwner || mRole !== "owner");
            return (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-label-sm text-text-strong-950">
                    {m.user.name || m.user.email}
                    {isSelf && <span className="ml-1.5 text-paragraph-xs text-text-soft-400">(you)</span>}
                  </p>
                  <p className="truncate text-paragraph-xs text-text-sub-600">
                    {m.user.email} · joined {date(m.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {editable && canUpdate ? (
                    <Select.Root size="xsmall" value={mRole} disabled={busy === `role-${m.id}`} onValueChange={(v) => void changeRole(m.id, v as OrgRole)}>
                      <Select.Trigger aria-label={`Role for ${m.user.email}`} className="w-28">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Content>
                        {assignable.map((r) => (
                          <Select.Item key={r} value={r}>{ROLE_LABELS[r]}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  ) : (
                    <span className="rounded-md bg-bg-weak-50 px-2 py-1 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
                      {ROLE_LABELS[mRole]}
                    </span>
                  )}
                  {editable && canRemove && (
                    <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy === `remove-${m.id}`} onClick={() => void removeMember(m.id, m.user.name || m.user.email)}>
                      Remove
                    </Button.Root>
                  )}
                </div>
              </div>
            );
          })}
        </FramePanel>
      </Frame>
    </div>
  );
}
