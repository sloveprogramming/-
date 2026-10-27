"use client";

import { useEffect, useState, type FormEvent } from "react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { authClient } from "@/lib/auth/client";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { useAsyncAction, useOrgAccess } from "./useOrgAccess";

function slugify(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function OrgGeneral() {
  const { org, role, loading, error: loadError, can, reload } = useOrgAccess();
  const dialogs = useDialogs();
  const { busy, error, setError, run } = useAsyncAction();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [logo, setLogo] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!org) return;
    // Seed the form once the organization arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setName(org.name);
    setSlug(org.slug);
    setLogo(org.logo ?? "");
  }, [org]);

  if (loading) return <p className="text-paragraph-sm text-text-sub-600">加载中…</p>;
  if (!org || !role) return <Callout tone="error">{loadError || "No active organization."}</Callout>;

  const canEdit = can({ organization: ["update"] });
  const dirty = name.trim() !== org.name || slugify(slug) !== org.slug || logo.trim() !== (org.logo ?? "");

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!org) return;
    setSaved(false);
    const finalSlug = slugify(slug);
    if (!name.trim() || !finalSlug) return setError("A name and a URL name are required.");
    if (finalSlug !== org.slug) {
      const check = await authClient.organization.checkSlug({ slug: finalSlug });
      if (check.error || !check.data?.status) return setError("That URL name is already taken. Try another.");
    }
    const ok = await run("save", () =>
      authClient.organization.update({
        organizationId: org.id,
        data: { name: name.trim(), slug: finalSlug, logo: logo.trim() || undefined },
      }),
    );
    if (ok) {
      // Refresh in place: a full page reload would turn the settings pop-up into the
      // standalone /settings page. The sidebar's Better Auth atoms refetch on their own
      // after /organization/update.
      await reload();
      setSaved(true);
    }
  }

  async function leave() {
    if (!org) return;
    const confirmed = await dialogs.confirm({
      title: `Leave ${org.name}?`,
      description: "You will lose access to its leads, campaigns and conversations until someone invites you again.",
      confirmLabel: "Leave organization",
      variant: "error",
    });
    if (!confirmed) return;
    const ok = await run("leave", () => authClient.organization.leave({ organizationId: org.id }));
    if (ok) window.location.assign("/onboarding");
  }

  return (
    <div className="flex flex-col gap-6">
      <Frame>
        <FrameHeader title="Organization" description={`Your role: ${ROLE_LABELS[role]}`} />
        <FramePanel>
          <form onSubmit={save} className="flex flex-col gap-4">
            <Field label="Name" htmlFor="org-name" required>
              <Input.Root size="medium">
                <Input.Wrapper>
                  <Input.Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
                </Input.Wrapper>
              </Input.Root>
            </Field>
            <Field label="URL name" htmlFor="org-slug" description="Lowercase letters, numbers and dashes." required>
              <Input.Root size="medium">
                <Input.Wrapper>
                  <Input.Input id="org-slug" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={!canEdit} />
                </Input.Wrapper>
              </Input.Root>
            </Field>
            <Field label="Logo URL" htmlFor="org-logo" optional>
              <Input.Root size="medium">
                <Input.Wrapper>
                  <Input.Input id="org-logo" type="url" placeholder="https://" value={logo} onChange={(e) => setLogo(e.target.value)} disabled={!canEdit} />
                </Input.Wrapper>
              </Input.Root>
            </Field>
            {error && <Callout tone="error">{error}</Callout>}
            {saved && <Callout tone="success">Saved.</Callout>}
            {canEdit ? (
              <div>
                <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!dirty || busy === "save"}>
                  {busy === "save" ? "Saving…" : "保存修改"}
                </Button.Root>
              </div>
            ) : (
              <p className="text-paragraph-xs text-text-sub-600">Only owners and admins can change these details.</p>
            )}
          </form>
        </FramePanel>
        <FrameFooter>Everyone in an organization sees the same leads, campaigns and conversations.</FrameFooter>
      </Frame>

      {role !== "owner" && (
        <Frame>
          <FrameHeader title="Leave organization" description="Remove yourself from this organization." />
          <FramePanel className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-paragraph-sm text-text-sub-600">You can be invited back at any time.</p>
            <Button.Root variant="error" mode="stroke" size="small" disabled={busy === "leave"} onClick={leave}>
              {busy === "leave" ? "Leaving…" : "Leave organization"}
            </Button.Root>
          </FramePanel>
        </Frame>
      )}
    </div>
  );
}
