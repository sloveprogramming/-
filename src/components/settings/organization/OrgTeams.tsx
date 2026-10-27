"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Select from "@/components/alignui/select";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { useDialogs } from "@/components/DialogProvider";
import { Callout } from "@/components/settings/SettingsKit";
import { authClient } from "@/lib/auth/client";
import { useAsyncAction, useOrgAccess, type OrgMember } from "./useOrgAccess";

type Team = { id: string; name: string };

export function OrgTeams() {
  const { org, role, loading, error: loadError, can } = useOrgAccess();
  const dialogs = useDialogs();
  const { busy, error, run } = useAsyncAction();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamMembers, setTeamMembers] = useState<Record<string, string[]>>({});
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [listError, setListError] = useState("");

  const orgId = org?.id;
  const loadTeams = useCallback(async () => {
    if (!orgId) return;
    const res = await authClient.organization.listTeams({ query: { organizationId: orgId } });
    if (res.error || !res.data) return setListError(res.error?.message || "Could not load teams.");
    setListError("");
    setTeams(res.data.map((t) => ({ id: t.id, name: t.name })));
    const entries = await Promise.all(
      res.data.map(async (t) => {
        const r = await authClient.organization.listTeamMembers({ query: { teamId: t.id } });
        return [t.id, r.data ? r.data.map((m) => m.userId) : []] as const;
      }),
    );
    setTeamMembers(Object.fromEntries(entries));
  }, [orgId]);

  useEffect(() => {
    // Fetch once the organization is known; state lands after the awaited responses.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTeams();
  }, [loadTeams]);

  if (loading) return <p className="text-paragraph-sm text-text-sub-600">加载中…</p>;
  if (!org || !role) return <Callout tone="error">{loadError || "No active organization."}</Callout>;

  const canCreate = can({ team: ["create"] });
  const canUpdate = can({ team: ["update"] });
  const canDelete = can({ team: ["delete"] });
  const byUser = new Map<string, OrgMember>(org.members.map((m) => [m.userId, m]));

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!org || !newName.trim()) return;
    const ok = await run("create", () => authClient.organization.createTeam({ name: newName.trim(), organizationId: org.id }));
    if (ok) {
      setNewName("");
      await loadTeams();
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming || !renaming.name.trim()) return;
    const target = renaming;
    const ok = await run(`rename-${target.id}`, () =>
      authClient.organization.updateTeam({ teamId: target.id, data: { name: target.name.trim() } }),
    );
    if (ok) {
      setRenaming(null);
      await loadTeams();
    }
  }

  async function remove(team: Team) {
    if (!org) return;
    const confirmed = await dialogs.confirm({
      title: `Delete ${team.name}?`,
      description: "People stay in the organization; only the team is removed.",
      confirmLabel: "Delete team",
      variant: "error",
    });
    if (!confirmed) return;
    const ok = await run(`delete-${team.id}`, () => authClient.organization.removeTeam({ teamId: team.id, organizationId: org.id }));
    if (ok) await loadTeams();
  }

  async function addMember(teamId: string) {
    const userId = adding[teamId];
    if (!userId) return;
    const ok = await run(`add-${teamId}`, () => authClient.organization.addTeamMember({ teamId, userId }));
    if (ok) {
      setAdding((a) => ({ ...a, [teamId]: "" }));
      await loadTeams();
    }
  }

  async function removeMember(teamId: string, userId: string) {
    const ok = await run(`rm-${teamId}-${userId}`, () => authClient.organization.removeTeamMember({ teamId, userId }));
    if (ok) await loadTeams();
  }

  return (
    <div className="flex flex-col gap-6">
      <Callout tone="info">Teams group people; everyone in the organization sees the same data.</Callout>
      {(error || listError) && <Callout tone="error">{error || listError}</Callout>}

      {canCreate && (
        <Frame>
          <FrameHeader title="Create a team" />
          <FramePanel>
            <form onSubmit={create} className="flex flex-col gap-3 sm:flex-row">
              <Input.Root size="small" className="flex-1">
                <Input.Wrapper>
                  <Input.Input aria-label="Team name" placeholder="Team name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                </Input.Wrapper>
              </Input.Root>
              <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={busy === "create" || !newName.trim()}>
                {busy === "create" ? "Creating…" : "Create team"}
              </Button.Root>
            </form>
          </FramePanel>
        </Frame>
      )}

      {teams.length === 0 ? (
        <p className="text-paragraph-sm text-text-sub-600">No teams yet.</p>
      ) : (
        teams.map((team) => {
          const ids = teamMembers[team.id] ?? [];
          const candidates = org.members.filter((m) => !ids.includes(m.userId));
          return (
            <Frame key={team.id}>
              <FrameHeader
                title={team.name}
                description={`${ids.length} ${ids.length === 1 ? "member" : "members"}`}
                actions={
                  <>
                    {canUpdate && (
                      <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setRenaming({ id: team.id, name: team.name })}>
                        Rename
                      </Button.Root>
                    )}
                    {canDelete && (
                      <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy === `delete-${team.id}`} onClick={() => void remove(team)}>
                        Delete
                      </Button.Root>
                    )}
                  </>
                }
              />
              <FramePanel className="flex flex-col gap-3">
                {renaming?.id === team.id && (
                  <form onSubmit={rename} className="flex gap-2">
                    <Input.Root size="small" className="flex-1">
                      <Input.Wrapper>
                        <Input.Input aria-label="New team name" autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: team.id, name: e.target.value })} />
                      </Input.Wrapper>
                    </Input.Root>
                    <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={busy === `rename-${team.id}`}>
                      Save
                    </Button.Root>
                    <Button.Root type="button" variant="neutral" mode="ghost" size="small" onClick={() => setRenaming(null)}>
                      Cancel
                    </Button.Root>
                  </form>
                )}
                {ids.length === 0 ? (
                  <p className="text-paragraph-xs text-text-sub-600">No one is on this team yet.</p>
                ) : (
                  <ul className="divide-y divide-stroke-soft-200">
                    {ids.map((uid) => {
                      const m = byUser.get(uid);
                      return (
                        <li key={uid} className="flex items-center justify-between gap-3 py-2">
                          <span className="min-w-0 truncate text-paragraph-sm text-text-strong-950">
                            {m ? m.user.name || m.user.email : uid}
                            {m && m.user.name && <span className="ml-1.5 text-paragraph-xs text-text-sub-600">{m.user.email}</span>}
                          </span>
                          {canUpdate && (
                            <Button.Root variant="error" mode="ghost" size="xsmall" disabled={busy === `rm-${team.id}-${uid}`} onClick={() => void removeMember(team.id, uid)}>
                              Remove
                            </Button.Root>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {canUpdate && candidates.length > 0 && (
                  <div className="flex gap-2">
                    <Select.Root size="small" value={adding[team.id] ?? ""} onValueChange={(v) => setAdding((a) => ({ ...a, [team.id]: v }))}>
                      <Select.Trigger aria-label={`Add a member to ${team.name}`}>
                        <Select.Value placeholder="Add a member…" />
                      </Select.Trigger>
                      <Select.Content>
                        {candidates.map((m) => (
                          <Select.Item key={m.userId} value={m.userId}>{m.user.name || m.user.email}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                    <Button.Root variant="neutral" mode="stroke" size="small" disabled={!adding[team.id] || busy === `add-${team.id}`} onClick={() => void addMember(team.id)}>
                      Add
                    </Button.Root>
                  </div>
                )}
              </FramePanel>
            </Frame>
          );
        })
      )}
    </div>
  );
}
