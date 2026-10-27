"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

type PersonRow = {
  person: { id: string; email: string | null; linkedinUrl: string | null; phone?: string | null; fullName: string | null; title: string | null };
  company: { name: string | null; domain: string } | null;
};

export default function AddPeopleToCampaignModal({
  campaignId,
  channel,
  onClose,
  onAdded,
}: {
  campaignId: string;
  channel: "email" | "linkedin" | "whatsapp";
  onClose: () => void;
  /** The WhatsApp route reports skippedMissingPhone instead of the identity/suppressed counts. */
  onAdded: (result: { requested: number; added: number; skippedMissingIdentity: number; skippedDuplicate: number; skippedSuppressed: number }) => void;
}) {
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ limit: "100" });
        if (query.trim()) params.set("q", query.trim());
        const response = await fetch(`/api/leads/people?${params}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "无法加载联系人");
        setRows(body.people ?? []);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "无法加载联系人");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [query]);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      const url = channel === "whatsapp" ? `/api/whatsapp/campaigns/${campaignId}/leads` : `/api/${channel === "email" ? "outreach" : "linkedin"}/campaigns/${campaignId}/people`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Sequence templates belong to the campaign editor. Including blank
        // template fields here would clear an existing LinkedIn sequence.
        body: JSON.stringify({ personIds: [...selected] }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "无法添加联系人");
      onAdded(
        channel === "whatsapp"
          ? {
              requested: selected.size,
              added: Number(body.added ?? 0),
              skippedMissingIdentity: Number(body.skippedMissingPhone ?? 0),
              skippedDuplicate: Number(body.skippedDuplicate ?? 0),
              skippedSuppressed: 0,
            }
          : body,
      );
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法添加联系人");
    } finally {
      setSaving(false);
    }
  }

  const identity = (person: PersonRow["person"]) => (channel === "email" ? person.email : channel === "whatsapp" ? person.phone : person.linkedinUrl);
  const eligible = rows.filter(({ person }) => identity(person));
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button className="absolute inset-0 bg-slate-950/50" aria-label="关闭" onClick={onClose} />
      <div className="relative flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
        <div className="border-b border-slate-200 p-5">
          <h2 className="text-base font-semibold text-slate-900">从联系人添加</h2>
          <p className="mt-1 text-sm text-slate-500">Only people with a {channel === "email" ? "valid email" : channel === "whatsapp" ? "phone number" : "LinkedIn profile"} can be selected.</p>
          <input
            className="mt-4 h-10 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-indigo-400"
            placeholder="搜索姓名、邮箱、公司、域名或 LinkedIn…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="min-h-48 flex-1 overflow-y-auto p-3">
          {loading ? <p className="p-4 text-sm text-slate-500">加载中…</p> : eligible.length === 0 ? <p className="p-4 text-sm text-slate-500">没有符合条件的联系人。</p> : eligible.map(({ person, company }) => (
            <label key={person.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50">
              <input
                type="checkbox"
                checked={selected.has(person.id)}
                onChange={() => setSelected((current) => {
                  const next = new Set(current);
                  if (next.has(person.id)) next.delete(person.id); else next.add(person.id);
                  return next;
                })}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-slate-900">{person.fullName || person.email || person.phone || person.linkedinUrl}</span>
                <span className="block truncate text-xs text-slate-500">{identity(person)}{company?.name ? ` · ${company.name}` : ""}</span>
              </span>
            </label>
          ))}
        </div>
        {error && <p className="px-5 pb-2 text-sm text-red-600">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-slate-200 p-4">
          <button className="rounded-lg border border-slate-200 px-4 py-2 text-sm" onClick={onClose}>取消</button>
          <button className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" disabled={!selected.size || saving} onClick={submit}>
            {saving ? "Adding…" : `Add ${selected.size || ""} ${selected.size === 1 ? "person" : "people"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
