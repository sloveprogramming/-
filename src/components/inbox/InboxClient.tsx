"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiAddLine,
  RiInboxLine,
  RiLayoutRightLine,
  RiMailOpenLine,
  RiSearchLine,
  RiStickyNoteLine,
  RiTaskLine,
  RiUserSearchLine,
} from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import * as Dropdown from "@/components/alignui/dropdown";
import { crmCategoryLabel as categoryName } from "@/lib/crm/labels";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { cn } from "@/utils/cn";
import InboxFolderTabs from "./InboxNav";
import EmailList, { leadDisplayName } from "./EmailList";
import EmailThread, { threadSubject, type ThreadMessage } from "./EmailThread";
import ReplyComposer from "./ReplyComposer";
import FilterPanel, { EMPTY_FILTERS, filtersActive, type InboxFilterState } from "./FilterPanel";
import QuickCreateModal from "./QuickCreateModal";
import { INBOX_SECTIONS, type InboxSectionKey } from "./inboxSections";
import {
  HeaderAction,
  InboxAvatar,
  InboxLayout,
  InlineError,
  ListCount,
  ListEnd,
  ListPane,
  ListSearch,
  ReadingEmpty,
  ReadingPane,
  RowBadge,
  ThreadHeader,
  ThreadSkeleton,
  type BadgeTone,
} from "./shell/InboxShell";
import { ComposerDock } from "./shell/Conversation";
import { ContactDetails, DetailsPanel, useCrmRecordSummary, useDetailsPanel, workflowLabel } from "./shell/DetailsPanel";
import { useInboxHotkeys } from "./shell/hotkeys";
import {
  CrmCategoryControl,
  CrmDraftCard,
  DoNotContactNotice,
  crmCategoryLabel,
  type CrmCategoryOption,
} from "@/components/crm/InboxCrmStrip";
import { crmFetch } from "@/components/crm/crm-utils";
import type { InboxMessageRow } from "@/lib/inbox/queries";
import { inboxCrmStepLabel, type InboxCrmContext } from "@/lib/linkedin/messages/crmContext";

type ThreadResponse = {
  lead: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    mailbox: string | null;
  };
  statusConfig: { label: string; statusGroup: string } | null;
  messages: ThreadMessage[];
  ccs: string[];
  /** Cc a reply-all to the latest inbound message gets (absent on an older payload). */
  replyAllCc?: { email: string; name: string | null }[];
  /** Absent on an older thread payload; then fetched from the crm-context route. */
  crm?: InboxCrmContext | null;
};

/** Polling window for the regenerated draft after a reclassification. */
const DRAFT_WATCH_MS = 45_000;

const PAGE_SIZE = 25;

const STATUS_GROUP_TONE: Record<string, BadgeTone> = { interested: "green", not_interested: "red", wrong_poc: "orange" };

/** What an empty folder means, when no search or filter is narrowing it. */
const SECTION_EMPTY: Record<InboxSectionKey, string> = {
  inbox: "Replies to your campaigns land here as they arrive.",
  replied: "Replies from leads, without the out-of-office auto-replies.",
  outOfOffice: "Auto-replies and out-of-office notices collect here.",
  pendingApproval: "AI-drafted replies waiting for your review show up here.",
  sent: "Emails sent from your mailboxes show up here.",
  important: "Star a message in a thread to keep it here.",
  scheduled: "Nothing is queued to send right now.",
};

export default function InboxClient() {
  const [section, setSection] = useState<InboxSectionKey>("inbox");
  const [rows, setRows] = useState<InboxMessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selected, setSelected] = useState<InboxMessageRow | null>(null);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [counts, setCounts] = useState<{ inbox?: number; important?: number; scheduled?: number }>({});
  const [crmContext, setCrmContext] = useState<InboxCrmContext | null>(null);
  const [crmCategories, setCrmCategories] = useState<CrmCategoryOption[]>([]);
  /** The CRM draft the operator chose to send as; resolved against the live context below. */
  const [activeDraftId, setActiveDraftId] = useState<string | null>(null);
  /** While set, the CRM context is polled for the regenerated draft until this time (ms). */
  const [draftWatchUntil, setDraftWatchUntil] = useState<number | null>(null);
  /** Draft that reclassification superseded — seeing it again does not end the watch. */
  const supersededDraftIdRef = useRef<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const activeLeadIdRef = useRef<string | null>(null);
  const [filters, setFilters] = useState<InboxFilterState>(EMPTY_FILTERS);
  const [quickCreate, setQuickCreate] = useState<{ type: "task" | "note"; leadId: string } | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 400);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    fetch("/api/outreach/inbox/counts")
      .then((r) => r.json())
      .then(setCounts)
      .catch(() => {});
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    crmFetch<{ categories?: CrmCategoryOption[] }>("/categories")
      .then((data) => {
        if (!cancelled) setCrmCategories(Array.isArray(data?.categories) ? data.categories : []);
      })
      .catch(() => {
        /* no CRM taxonomy: the picker stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Accepts a context for the lead still open; a finished draft ends the post-classification watch. */
  const applyCrmContext = useCallback((leadId: string, context: InboxCrmContext | null) => {
    if (activeLeadIdRef.current !== leadId) return;
    setCrmContext(context);
    const draft = context?.draft;
    if (draft && draft.status !== "generating" && draft.id !== supersededDraftIdRef.current) setDraftWatchUntil(null);
  }, []);

  /** Anything but `{ context }` (route missing, 404, non-CRM lead) reads as "no strip". */
  const loadCrmContext = useCallback(
    async (leadId: string) => {
      try {
        const res = await fetch(`/api/outreach/inbox/leads/${leadId}/crm-context`);
        const data = res.ok ? await res.json() : null;
        applyCrmContext(leadId, (data?.context as InboxCrmContext | undefined) ?? null);
      } catch {
        /* network error: keep whatever the strip already shows */
      }
    },
    [applyCrmContext],
  );

  /**
   * "Use draft" only holds while the server still offers that draft for
   * review; a regenerated or already-sent draft drops the reply back to a
   * plain inbox send. A revision bump is followed automatically.
   */
  const activeDraft = useMemo(() => {
    const draft = crmContext?.draft;
    if (!activeDraftId || !draft || draft.id !== activeDraftId || draft.status !== "awaiting_review") return null;
    return { id: draft.id, revision: draft.revision, subject: draft.subject, body: draft.body };
  }, [activeDraftId, crmContext?.draft]);

  // After a reclassification the CRM regenerates the draft asynchronously:
  // poll every 3s until a finished draft shows up, for at most ~45s.
  useEffect(() => {
    const leadId = selected?.leadId;
    if (!draftWatchUntil || !leadId) return;
    const interval = setInterval(() => {
      if (Date.now() > draftWatchUntil) setDraftWatchUntil(null);
      else void loadCrmContext(leadId);
    }, 3_000);
    return () => clearInterval(interval);
  }, [draftWatchUntil, selected?.leadId, loadCrmContext]);

  const fetchRows = useCallback(
    async (targetSection: InboxSectionKey, q: string, targetPage: number, append: boolean, activeFilters: InboxFilterState) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ section: targetSection, page: String(targetPage), pageSize: String(PAGE_SIZE) });
        if (q) params.set("q", q);
        if (activeFilters.leadIds.length) params.set("leadIds", activeFilters.leadIds.join(","));
        if (activeFilters.campaignIds.length) params.set("campaignIds", activeFilters.campaignIds.join(","));
        if (activeFilters.accounts.length) params.set("accounts", activeFilters.accounts.join(","));
        if (activeFilters.statusKeys.length) params.set("statusKeys", activeFilters.statusKeys.join(","));
        if (activeFilters.statusGroups.length) params.set("statusGroups", activeFilters.statusGroups.join(","));
        if (activeFilters.startDate) params.set("startDate", activeFilters.startDate);
        if (activeFilters.endDate) params.set("endDate", activeFilters.endDate);
        const res = await fetch(`/api/outreach/inbox?${params}`);
        const data = await res.json();
        const newRows = targetSection === "scheduled" ? mapScheduledToRows(data.rows) : (data.rows as InboxMessageRow[]);
        setRows((prev) => (append ? [...prev, ...newRows] : newRows));
        setTotal(data.total);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // A new folder, search or filter starts the list over from page one.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets paging and the open thread alongside the refetch
    setPage(1);
    setSelected(null);
    setThread(null);
    fetchRows(section, debouncedSearch, 1, false, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, debouncedSearch, filters]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && rows.length < total) {
          const nextPage = page + 1;
          setPage(nextPage);
          fetchRows(section, debouncedSearch, nextPage, true, filters);
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loading, rows.length, total, page, section, debouncedSearch, filters, fetchRows]);

  async function openLead(row: InboxMessageRow) {
    setSelected(row);
    // A CRM draft belongs to the lead it was drafted for: never carry it over.
    if (activeLeadIdRef.current !== row.leadId) {
      setCrmContext(null);
      setActiveDraftId(null);
      setDraftWatchUntil(null);
      supersededDraftIdRef.current = null;
    }
    activeLeadIdRef.current = row.leadId;
    setSendError(null);

    // Scheduled rows come from outreach execution, not Master Inbox, so no
    // thread exists yet. Show the row itself as a
    // simple preview instead of fetching a (nonexistent) crm thread.
    if (section === "scheduled") {
      setThread(null);
      return;
    }

    setThreadLoading(true);
    try {
      const res = await fetch(`/api/outreach/inbox/leads/${row.leadId}/thread`);
      const data: ThreadResponse = await res.json();
      setThread(data);
      if (data.crm !== undefined) applyCrmContext(row.leadId, data.crm);
      else void loadCrmContext(row.leadId);
      if (!row.openedAt && row.direction === "inbound") {
        fetch(`/api/outreach/inbox/messages/${row.id}/opened`, { method: "POST" });
        setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, openedAt: new Date().toISOString() as unknown as Date } : r)));
      }
    } finally {
      setThreadLoading(false);
    }
  }

  async function handleToggleImportant(messageId: string, next: boolean) {
    await fetch(`/api/outreach/inbox/messages/${messageId}/important`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ important: next }),
    });
    setThread((prev) =>
      prev ? { ...prev, messages: prev.messages.map((m) => (m.id === messageId ? { ...m, important: next } : m)) } : prev,
    );
    setRows((prev) => prev.map((r) => (r.id === messageId ? { ...r, important: next } : r)));
  }

  /**
   * Sends through the inbox reply route. With a draft in the composer the
   * send is recorded as that CRM draft (edits included); a 409 means the
   * draft moved on underneath us, so the strip is resynced. Rejects so the
   * composer keeps its text.
   */
  async function handleSendReply(payload: { cc: string[]; bcc: string[]; subject: string; html: string; text: string }) {
    if (!thread) return;
    const leadId = thread.lead.id;
    setSendError(null);
    const res = await fetch(`/api/outreach/inbox/leads/${leadId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        ...(payload.cc.length > 0 ? { cc: payload.cc } : {}),
        ...(payload.bcc.length > 0 ? { bcc: payload.bcc } : {}),
        ...(activeDraft ? { draftId: activeDraft.id, revision: activeDraft.revision } : {}),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      const message = typeof data?.error === "string" && data.error ? data.error : `Could not send (HTTP ${res.status})`;
      setSendError(message);
      void loadCrmContext(leadId);
      throw new Error(message);
    }
    setActiveDraftId(null);
    if (selected) void openLead(selected);
  }

  const leadName = thread ? leadDisplayName(thread.lead.firstName, thread.lead.lastName, thread.lead.email) : "";
  const lastMessage = thread?.messages[thread.messages.length - 1];
  const doNotContact = crmContext?.doNotContact === true;
  const sectionLabel = INBOX_SECTIONS.find((s) => s.key === section)?.label ?? "Inbox";
  const narrowing = Boolean(debouncedSearch) || filtersActive(filters);
  const firstLoad = loading && rows.length === 0;
  // A refetch (new folder, search or filter) keeps the old rows, dimmed; paging in more does not dim.
  const refetching = loading && rows.length > 0 && page === 1;
  // Same lead re-opened (after a send): keep the thread on screen, dimmed, instead of a skeleton.
  const threadRefreshing = threadLoading && thread !== null && thread.lead.id === selected?.leadId;
  const rowName = selected ? leadDisplayName(selected.leadFirstName, selected.leadLastName, selected.leadEmail) : "";
  const recordId = crmContext?.recordId ?? selected?.crm?.recordId ?? null;
  const details = useDetailsPanel(selected && section !== "scheduled" ? selected.leadId : null);
  const { summary: record, loading: recordLoading } = useCrmRecordSummary(recordId, details.open);
  const closeThread = useCallback(() => setSelected(null), []);
  useInboxHotkeys({ listRef, onClose: selected ? closeThread : null });

  const header = (
    <PageHeader
      title="Master Inbox"
      description="Every email reply across your mailboxes, in one place."
      actions={
        <>
          <Button.Root variant="neutral" mode="stroke" size="small" asChild>
            <Link href="/outreach/tasks">
              <Button.Icon as={RiTaskLine} />
              Tasks
            </Link>
          </Button.Root>
          <Button.Root variant="neutral" mode="stroke" size="small" asChild>
            <Link href="/outreach/notes">
              <Button.Icon as={RiStickyNoteLine} />
              Notes
            </Link>
          </Button.Root>
        </>
      }
    />
  );

  const detailsPanel =
    selected && section !== "scheduled" ? (
      <DetailsPanel open={details.open} wide={details.wide} onClose={() => details.setOpen(false)}>
        <ContactDetails
          name={record?.fullName ?? (leadName || rowName)}
          avatarSrc={record?.profilePictureUrl}
          headline={record?.title}
          company={record?.company ?? (thread?.lead.company || selected.leadCompany ? { name: thread?.lead.company ?? selected.leadCompany } : null)}
          channel="email"
          links={{
            recordId,
            email: thread?.lead.email ?? selected.leadEmail,
            phone: record?.phone,
            linkedinUrl: record?.linkedinUrl,
          }}
          crm={
            crmContext || record
              ? {
                  recordId,
                  categoryKey: crmContext?.categoryKey ?? record?.categoryKey ?? null,
                  categoryLabel: crmContext ? crmCategoryLabel(crmContext) : (record?.subcategory ?? (record?.categoryKey ? categoryName(record.categoryKey) : "未分类")),
                  stage: workflowLabel(crmContext?.workflowState ?? record?.workflowState),
                  sequence: crmContext?.sequenceName ?? record?.sequence,
                  step: crmContext ? inboxCrmStepLabel(crmContext) : null,
                  nextActionAt: crmContext?.nextActionAt ?? record?.nextActionAt,
                  lastInboundAt: record?.lastInboundAt,
                  lastOutboundAt: record?.lastOutboundAt,
                  doNotContact,
                }
              : null
          }
          crmLoading={Boolean(recordId) && recordLoading && !crmContext}
          facts={[
            ...(thread?.lead.mailbox ? [{ label: "Mailbox", value: thread.lead.mailbox, title: thread.lead.mailbox }] : []),
            ...(thread?.statusConfig ? [{ label: "Lead status", value: thread.statusConfig.label }] : []),
            ...(thread ? [{ label: "Messages", value: String(thread.messages.length) }] : []),
            ...(thread && thread.ccs.length > 0 ? [{ label: "Cc", value: thread.ccs.join(", "), title: thread.ccs.join(", ") }] : []),
          ]}
        />
      </DetailsPanel>
    ) : undefined;

  const headerActions = (leadId: string) => (
    <>
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <Button.Root variant="neutral" mode="stroke" size="xsmall" className="@max-3xl:w-8 @max-3xl:px-0" title="Add a task or note" aria-label="Add a task or note">
            <Button.Icon as={RiAddLine} />
            <span className="hidden @3xl:inline">Add</span>
          </Button.Root>
        </Dropdown.Trigger>
        <Dropdown.Content align="end">
          <Dropdown.Item onSelect={() => setQuickCreate({ type: "task", leadId })}>
            <Dropdown.ItemIcon as={RiTaskLine} className="size-4 text-text-sub-600" />
            Task
          </Dropdown.Item>
          <Dropdown.Item onSelect={() => setQuickCreate({ type: "note", leadId })}>
            <Dropdown.ItemIcon as={RiStickyNoteLine} className="size-4 text-text-sub-600" />
            Note
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Root>
      {recordId && (
        <Button.Root variant="neutral" mode="stroke" size="xsmall" asChild className="@max-3xl:w-8 @max-3xl:px-0" title="Open CRM record">
          <Link href={`/crm/records/${recordId}`} aria-label="Open CRM record">
            <Button.Icon as={RiUserSearchLine} />
            <span className="hidden @3xl:inline">Record</span>
          </Link>
        </Button.Root>
      )}
      <HeaderAction icon={RiLayoutRightLine} label={details.open ? "Hide details" : "Show details"} onClick={details.toggle} pressed={details.open} iconOnly />
    </>
  );

  return (
    <InboxLayout header={header} threadOpen={selected !== null}>
      <ListPane
        label={`${sectionLabel} emails`}
        hidden={selected !== null}
        busy={refetching}
        scrollRef={listRef}
        toolbar={
          <div className="flex items-center gap-2">
            <ListSearch value={search} onChange={setSearch} placeholder="Search emails, leads…" label="Search emails" />
            <FilterPanel value={filters} onApply={setFilters} />
          </div>
        }
        tabs={<InboxFolderTabs active={section} onSelect={setSection} counts={counts} />}
        footer={
          <>
            <ListCount shown={rows.length} total={total} noun={total === 1 ? "email" : "emails"} loading={firstLoad} />
            {filtersActive(filters) && (
              <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="text-label-xs text-primary-base outline-none hover:underline focus-visible:underline">
                Clear filters
              </button>
            )}
          </>
        }
      >
        {!firstLoad && rows.length === 0 ? (
          narrowing ? (
            <EmptyState
              compact
              icon={RiSearchLine}
              title="No emails match"
              description="Try another search, or clear the filters."
              action={
                filtersActive(filters) ? (
                  <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setFilters(EMPTY_FILTERS)}>
                    Clear filters
                  </Button.Root>
                ) : undefined
              }
            />
          ) : (
            <EmptyState
              compact
              icon={RiInboxLine}
              title={section === "inbox" ? "No replies yet" : `Nothing in ${sectionLabel}`}
              description={SECTION_EMPTY[section]}
            />
          )
        ) : (
          <>
            <EmailList
              rows={rows}
              selectedId={selected?.id ?? null}
              onSelect={openLead}
              loading={firstLoad}
              suppressDateDividers={section === "scheduled"}
              bundleAutomated={section === "inbox" || section === "replied"}
            />
            <div ref={sentinelRef} className="h-4" />
            {loading && rows.length > 0 && page > 1 && <ListEnd>Loading more…</ListEnd>}
            {!loading && rows.length >= total && rows.length > 0 && <ListEnd>That&apos;s everything in {sectionLabel}</ListEnd>}
          </>
        )}
      </ListPane>

      <ReadingPane shown={selected !== null} aside={detailsPanel}>
        {selected && section === "scheduled" ? (
          <>
            <ThreadHeader
              onBack={closeThread}
              backLabel="Back to emails"
              avatar={<InboxAvatar name={rowName} />}
              title={rowName}
              badges={
                <RowBadge tone="orange" dot={false}>
                  Scheduled — not yet sent
                </RowBadge>
              }
              channel="email"
              subtitle={`To ${selected.toEmail} · from ${selected.fromEmail ?? "unassigned mailbox"}`}
            />
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
                <h2 className="mb-4 text-label-lg text-text-strong-950">{selected.subject || "(no subject)"}</h2>
                <article className="rounded-xl bg-bg-weak-50 p-4 ring-1 ring-inset ring-stroke-soft-200 sm:px-5">
                  <p className="text-paragraph-xs text-text-soft-400">Queued in the campaign — edit or cancel it from the campaign.</p>
                  <p className="mt-3 whitespace-pre-wrap wrap-break-word text-paragraph-sm leading-6 text-text-strong-950">{selected.bodyText}</p>
                </article>
              </div>
            </div>
          </>
        ) : !selected ? (
          <ReadingEmpty icon={RiMailOpenLine} title="Select an email" description="Pick a conversation from the list to read the thread and reply." />
        ) : !thread || (threadLoading && !threadRefreshing) ? (
          <>
            <ThreadHeader
              onBack={closeThread}
              backLabel="Back to emails"
              avatar={<InboxAvatar name={rowName} />}
              title={rowName}
              channel="email"
              subtitle={selected.leadCompany ?? selected.leadEmail}
              actions={headerActions(selected.leadId)}
            />
            <ThreadSkeleton />
          </>
        ) : (
          <>
            <ThreadHeader
              onBack={closeThread}
              backLabel="Back to emails"
              avatar={<InboxAvatar name={leadName} src={record?.profilePictureUrl} />}
              title={leadName}
              badges={
                crmContext ? (
                  <CrmCategoryControl
                    context={crmContext}
                    categories={crmCategories}
                    onClassified={() => {
                      supersededDraftIdRef.current = crmContext.draft?.id ?? null;
                      setActiveDraftId(null);
                      setDraftWatchUntil(Date.now() + DRAFT_WATCH_MS);
                      void loadCrmContext(thread.lead.id);
                    }}
                  />
                ) : thread.statusConfig ? (
                  <RowBadge tone={STATUS_GROUP_TONE[thread.statusConfig.statusGroup] ?? "gray"}>{thread.statusConfig.label}</RowBadge>
                ) : undefined
              }
              channel="email"
              subtitle={[thread.lead.company, thread.lead.email].filter(Boolean).join(" · ")}
              extra={thread.ccs.length > 0 ? `Cc: ${thread.ccs.join(", ")}` : undefined}
              actions={headerActions(thread.lead.id)}
            />
            <div aria-busy={threadRefreshing || undefined} className={cn("min-h-0 flex-1 overflow-y-auto transition-opacity", threadRefreshing && "opacity-60")}>
              <EmailThread messages={thread.messages} leadName={leadName} leadEmail={thread.lead.email} onToggleImportant={handleToggleImportant} />
            </div>
            {/* Capped so the thread keeps a share of the pane; the composer's body scrolls inside it. */}
            <ComposerDock className="flex max-h-[75%] flex-col">
              {doNotContact ? (
                <DoNotContactNotice />
              ) : !thread.lead.mailbox ? (
                <p className="py-1 text-center text-paragraph-xs text-text-soft-400">No sending mailbox is linked to this lead, so replies can&apos;t be sent from here.</p>
              ) : (
                <>
                  {crmContext?.draft && (
                    <CrmDraftCard
                      draft={crmContext.draft}
                      active={activeDraft?.id === crmContext.draft.id}
                      onUse={() => {
                        setSendError(null);
                        setActiveDraftId(crmContext.draft!.id);
                      }}
                    />
                  )}
                  {sendError && (
                    <InlineError>
                      <span className="flex items-start gap-2">
                        {sendError}
                        <button type="button" onClick={() => setSendError(null)} className="text-error-dark/70 hover:text-error-dark" aria-label="Dismiss">
                          ×
                        </button>
                      </span>
                    </InlineError>
                  )}
                  <ReplyComposer
                    key={`${selected.id}-${thread.lead.id}-${lastMessage?.id ?? ""}` + (activeDraft ? `-draft-${activeDraft.id}` : "")}
                    from={thread.lead.mailbox}
                    replyToName={leadName}
                    initialTo={[thread.lead.email]}
                    initialCc={(thread.replyAllCc ?? []).map((a) => a.email)}
                    initialSubject={activeDraft?.subject || (lastMessage?.subject ? `Re: ${threadSubject(lastMessage.subject)}` : "")}
                    initialBody={activeDraft?.body}
                    quotedText={lastMessage?.bodyText ?? undefined}
                    quotedFrom={lastMessage?.fromEmail ?? undefined}
                    quotedDate={lastMessage?.sentAt ? new Date(lastMessage.sentAt).toLocaleString() : undefined}
                    isDraftApproval={activeDraft !== null}
                    onSend={handleSendReply}
                    onCancel={activeDraft ? () => setActiveDraftId(null) : undefined}
                  />
                  {activeDraft && <p className="text-right text-paragraph-xs text-text-soft-400">Sending as the CRM draft — your edits are kept</p>}
                </>
              )}
            </ComposerDock>
          </>
        )}
      </ReadingPane>

      {quickCreate && (
        <QuickCreateModal
          type={quickCreate.type}
          leadId={quickCreate.leadId}
          leadName={leadName || rowName || undefined}
          onClose={() => setQuickCreate(null)}
          onCreated={() => {}}
        />
      )}
    </InboxLayout>
  );
}

/** Scheduled section returns a different row shape (outreach_emails, no sentAt/direction) — adapt to InboxMessageRow for the shared list component. */
function mapScheduledToRows(scheduled: {
  id: string;
  leadId: string;
  subject: string | null;
  body: string | null;
  leadEmail: string;
  leadFirstName: string | null;
  leadLastName: string | null;
  mailboxAddress: string | null;
}[]): InboxMessageRow[] {
  return scheduled.map((s) => ({
    id: s.id,
    leadId: s.leadId,
    direction: "outbound" as const,
    subject: s.subject,
    bodyText: s.body,
    fromEmail: s.mailboxAddress,
    toEmail: s.leadEmail,
    sentAt: null,
    important: false,
    openedAt: null,
    leadEmail: s.leadEmail,
    leadFirstName: s.leadFirstName,
    leadLastName: s.leadLastName,
    leadCompany: null,
    leadMailbox: s.mailboxAddress,
    leadCampaignId: null,
    currentStatusKey: null,
    statusLabel: null,
    statusGroup: null,
    hasDraft: false,
  }));
}
