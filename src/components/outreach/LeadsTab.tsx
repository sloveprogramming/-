"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RiAddLine, RiSearchLine, RiUploadCloud2Line } from "@remixicon/react";

import * as Avatar from "@/components/alignui/avatar";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import * as Table from "@/components/alignui/table";
import ImportCampaignLeadsModal from "./ImportCampaignLeadsModal";
import AddPeopleToCampaignModal from "@/components/leads/AddPeopleToCampaignModal";
import LeadActivityPanel from "./LeadActivityPanel";
import { Frame, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { CHANNEL_META } from "@/components/analytics/theme";
import { cn } from "@/utils/cn";
import type { OutreachLeadStatus } from "@/lib/outreach/schema";
import type { LeadPage } from "@/lib/outreach/campaigns";

const STATUS_COLOR: Record<OutreachLeadStatus, React.ComponentProps<typeof Badge.Root>["color"]> = {
  pending: "gray",
  initial_sent: "blue",
  in_follow_up: "blue",
  reply_processing: "yellow",
  sequence_completed: "purple",
  reply_received: "green",
  bounced: "red",
  suppressed: "orange",
};
const STATUS_LABEL: Record<OutreachLeadStatus, string> = {
  pending: "待发送",
  initial_sent: "序列中",
  in_follow_up: "序列中",
  reply_processing: "处理回复中",
  sequence_completed: "已完成",
  reply_received: "已回复",
  bounced: "退信",
  suppressed: "已屏蔽",
};

const FILTERS: { id: string; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待发送" },
  { id: "in_sequence", label: "序列中" },
  { id: "replied", label: "已回复" },
  { id: "completed", label: "已完成" },
  { id: "bounced", label: "退信" },
  { id: "suppressed", label: "已屏蔽" },
];

/** Avatar tint is derived from the email so a lead keeps the same colour. */
const AVATAR_COLORS = ["blue", "purple", "sky", "yellow", "red", "gray"] as const;
function avatarColor(seed: string) {
  let n = 0;
  for (let i = 0; i < seed.length; i++) n = (n + seed.charCodeAt(i)) % AVATAR_COLORS.length;
  return AVATAR_COLORS[n];
}

function initials(email: string, firstName: string | null, lastName: string | null) {
  const first = firstName?.trim()?.[0];
  const last = lastName?.trim()?.[0];
  if (first && last) return `${first}${last}`;
  if (first) return first;
  return email.slice(0, 2);
}

/** Strips merge tokens and collapses whitespace for the one-line preview. */
function snippet(text: string | null, max = 60): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function nextSend(date: Date | string | null): string {
  if (!date) return "—";
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function LeadsTab({
  campaignId,
  initialPage,
  onImported,
}: {
  campaignId: string;
  initialPage: LeadPage;
  onImported: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showPeople, setShowPeople] = useState(false);
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);

  // Rows accumulate across pages rather than being replaced, so the table grows
  // as you scroll. `meta` holds everything about the result set that isn't the
  // rows themselves — total, counts, and which page was last appended.
  const [leads, setLeads] = useState(initialPage.leads);
  const [meta, setMeta] = useState<Omit<LeadPage, "leads">>({
    total: initialPage.total,
    page: initialPage.page,
    pageSize: initialPage.pageSize,
    counts: initialPage.counts,
    sequenceLength: initialPage.sequenceLength,
  });
  const [loading, setLoading] = useState(false);
  const firstRender = useRef(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Guards the scroll handler against firing a second request for the same page
  // while the first is still in flight — a ref, not state, because the observer
  // callback closes over the value at registration time.
  const loadingRef = useRef(false);

  const load = useCallback(
    async (opts: { page?: number; append?: boolean } = {}) => {
      const page = opts.page ?? 1;
      if (loadingRef.current) return;
      loadingRef.current = true;
      setLoading(true);
      try {
        const qs = new URLSearchParams({
          page: String(page),
          pageSize: String(initialPage.pageSize),
        });
        if (filter !== "all") qs.set("filter", filter);
        if (search.trim()) qs.set("search", search.trim());
        const res = await fetch(`/api/outreach/campaigns/${campaignId}/leads?${qs}`);
        if (!res.ok) return;
        const next = (await res.json()) as LeadPage;
        setLeads((prev) => {
          if (!opts.append) return next.leads;
          // De-dupe by id: a lead whose status changes between requests can
          // shift across the page boundary and arrive twice.
          const seen = new Set(prev.map((l) => l.id));
          return [...prev, ...next.leads.filter((l) => !seen.has(l.id))];
        });
        setMeta({
          total: next.total,
          page: next.page,
          pageSize: next.pageSize,
          counts: next.counts,
          sequenceLength: next.sequenceLength,
        });
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [campaignId, filter, search, initialPage.pageSize],
  );

  // Debounce search so typing doesn't fire a query per keystroke. Skips the
  // first render, which already has server-rendered page 1. A filter or search
  // change restarts from page 1 and replaces the accumulated rows.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const t = setTimeout(() => void load({ page: 1 }), 300);
    return () => clearTimeout(t);
  }, [search, filter, load]);

  const counts = meta.counts;
  const steps = Math.max(1, meta.sequenceLength);
  const hasMore = leads.length < meta.total;

  // Infinite scroll: fetch the next page when the sentinel below the table
  // comes into view. rootMargin starts the request before it is actually
  // visible, so the rows are usually there by the time you reach them.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !loadingRef.current) {
          void load({ page: meta.page + 1, append: true });
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, meta.page, load]);

  const filtering = Boolean(search.trim()) || filter !== "all";

  return (
    <div>
      <Frame>
        <FrameHeader
          title="联系人"
          description={filtering ? `${meta.total.toLocaleString("zh-CN")} 位联系人匹配。选一位查看邮件记录。` : "选一位联系人，查看其邮件与回复。"}
          actions={
            <>
              <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setShowPeople(true)}>
                <Button.Icon as={RiAddLine} />
                从联系人添加
              </Button.Root>
              <Button.Root variant="primary" mode="filled" size="xsmall" onClick={() => setShowImport(true)}>
                <Button.Icon as={RiUploadCloud2Line} />
                上传 CSV
              </Button.Root>
            </>
          }
        />
        <FramePanel className="p-2 sm:p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 pb-3">
            <div className="max-w-full overflow-x-auto">
              <SegmentedControl.Root value={filter} onValueChange={setFilter}>
                <SegmentedControl.List className="w-auto">
                  {FILTERS.map((f) => (
                    <SegmentedControl.Trigger key={f.id} value={f.id} className="gap-1.5 whitespace-nowrap px-3">
                      {f.label}
                      <span className="tabular-nums text-text-soft-400">{(counts[f.id] ?? 0).toLocaleString("zh-CN")}</span>
                    </SegmentedControl.Trigger>
                  ))}
                </SegmentedControl.List>
              </SegmentedControl.Root>
            </div>
            <Input.Root size="small" className="w-full sm:w-72">
              <Input.Wrapper>
                <Input.Icon as={RiSearchLine} />
                <Input.Input type="search" aria-label="搜索联系人" placeholder="搜索姓名、邮箱或公司…" value={search} onChange={(e) => setSearch(e.target.value)} />
              </Input.Wrapper>
            </Input.Root>
          </div>

          {leads.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-label-sm text-text-strong-950">{meta.total === 0 && !filtering ? "还没有联系人" : "没有匹配的联系人"}</p>
              <p className="mt-1 text-paragraph-sm text-text-sub-600">{meta.total === 0 && !filtering ? "上传一份 CSV 或从联系人里添加即可开始。" : "换个状态或搜索词试试。"}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table.Root className="min-w-[880px]">
                <Table.Header>
                  <Table.Row>
                    <Table.Head scope="col" className="px-4">联系人</Table.Head>
                    <Table.Head scope="col" className="w-72 px-4">最近邮件</Table.Head>
                    <Table.Head scope="col" className="w-48 px-4">进度</Table.Head>
                    <Table.Head scope="col" className="w-40 px-4">下次发送</Table.Head>
                    <Table.Head scope="col" className="w-40 px-4">状态</Table.Head>
                  </Table.Row>
                </Table.Header>

                <Table.Body spacing={4}>
                  {leads.map((lead) => {
                    const name = [lead.firstName, lead.lastName].filter(Boolean).join(" ") || lead.email;
                    const done = Math.min(lead.sentCount, steps);
                    const pct = Math.round((done / steps) * 100);
                    return (
                      <Table.Row
                        key={lead.id}
                        tabIndex={0}
                        onClick={() => setActiveLeadId(lead.id)}
                        onKeyDown={(e) => { if (e.target === e.currentTarget && e.key === "Enter") setActiveLeadId(lead.id); }}
                        className={cn("cursor-pointer outline-none focus-visible:[&>td]:bg-bg-weak-50", activeLeadId === lead.id && "[&>td]:bg-bg-weak-50")}
                      >
                        <Table.Cell className="h-14 px-4">
                          <div className="flex min-w-0 items-center gap-3">
                            <Avatar.Root size="32" color={avatarColor(lead.email)}>
                              {initials(lead.email, lead.firstName, lead.lastName)}
                            </Avatar.Root>
                            <div className="min-w-0">
                              <p className="truncate text-label-sm text-text-strong-950">{name}</p>
                              <p className="truncate text-paragraph-xs text-text-sub-600">{lead.email}</p>
                            </div>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="px-4">
                          <p className="line-clamp-2 text-paragraph-sm text-text-sub-600">{snippet(lead.lastMessageBody ?? lead.lastMessageSubject)}</p>
                        </Table.Cell>
                        <Table.Cell className="px-4">
                          <div className="flex items-center gap-2.5">
                            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-bg-weak-50">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: CHANNEL_META.email.color }} />
                            </div>
                            <span className="shrink-0 text-paragraph-xs tabular-nums text-text-sub-600">{done}/{steps}</span>
                          </div>
                        </Table.Cell>
                        <Table.Cell className="whitespace-nowrap px-4 text-paragraph-sm text-text-sub-600">{nextSend(lead.nextSendAt)}</Table.Cell>
                        <Table.Cell className="px-4">
                          <Badge.Root size="medium" variant="lighter" color={STATUS_COLOR[lead.sequenceStatus]}>
                            <Badge.Dot />
                            {STATUS_LABEL[lead.sequenceStatus]}
                          </Badge.Root>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Root>
            </div>
          )}

          {meta.total > 0 && (
            <>
              {/* Watched by the observer above — crossing it pulls the next page. */}
              <div ref={sentinelRef} aria-hidden="true" className="h-px" />
              <div className="mt-2 flex items-center justify-center gap-3 border-t border-stroke-soft-200 pt-3">
                <p className="text-paragraph-xs text-text-sub-600">
                  {loading
                    ? "Loading more…"
                    : hasMore
                      ? `Showing ${leads.length.toLocaleString("en-US")} of ${meta.total.toLocaleString("en-US")}`
                      : `All ${meta.total.toLocaleString("en-US")} ${meta.total === 1 ? "lead" : "leads"} loaded`}
                </p>
                {/* Keyboard and no-JS-observer fallback for reaching the next page. */}
                {hasMore && !loading && (
                  <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void load({ page: meta.page + 1, append: true })}>
                    Load more
                  </Button.Root>
                )}
              </div>
            </>
          )}
        </FramePanel>
      </Frame>

      {showImport && (
        <ImportCampaignLeadsModal
          campaignId={campaignId}
          onClose={() => setShowImport(false)}
          onImported={onImported}
        />
      )}

      {showPeople && (
        <AddPeopleToCampaignModal
          campaignId={campaignId}
          channel="email"
          onClose={() => setShowPeople(false)}
          onAdded={onImported}
        />
      )}

      {activeLeadId && (
        <LeadActivityPanel
          campaignId={campaignId}
          leadId={activeLeadId}
          onClose={() => setActiveLeadId(null)}
        />
      )}
    </div>
  );
}
