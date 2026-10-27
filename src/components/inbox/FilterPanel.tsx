"use client";

import { useEffect, useId, useState } from "react";
import { RiArrowDownSLine, RiSearchLine } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Input from "@/components/alignui/input";
import * as SegmentedControl from "@/components/alignui/segmented-control";
import { cn } from "@/utils/cn";
import { FilterField, FilterPopover } from "./shell/InboxShell";

export type InboxFilterState = {
  leadIds: string[];
  campaignIds: string[];
  accounts: string[];
  statusKeys: string[];
  statusGroups: string[];
  startDate: string | null;
  endDate: string | null;
};

export const EMPTY_FILTERS: InboxFilterState = {
  leadIds: [],
  campaignIds: [],
  accounts: [],
  statusKeys: [],
  statusGroups: [],
  startDate: null,
  endDate: null,
};

/** How many filter groups are set — the number on the Filter button. */
function activeFilterCount(f: InboxFilterState): number {
  return (
    [f.leadIds, f.campaignIds, f.accounts, f.statusKeys, f.statusGroups].filter((list) => list.length > 0).length +
    (f.startDate || f.endDate ? 1 : 0)
  );
}

function filtersActive(f: InboxFilterState): boolean {
  return activeFilterCount(f) > 0;
}

type LeadOption = { id: string; name: string; subtitle: string | null };
type CampaignOption = { id: string; name: string };
type StatusOption = { statusKey: string; label: string; statusGroup: string };

const LEAD_STATUS_GROUPS: { key: string; label: string }[] = [
  { key: "interested", label: "有意向" },
  { key: "not_interested", label: "无意向" },
  { key: "wrong_poc", label: "对接人不对" },
  { key: "other", label: "其他" },
];

type TimeMode = "all" | "today" | "yesterday" | "custom";
const TIME_MODES: { key: TimeMode; label: string }[] = [
  { key: "all", label: "全部时间" },
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "custom", label: "自定义" },
];

/** A collapsible checklist: the section title with how many are ticked, the options when open. */
function CollapsibleMultiSelect<T extends { id: string; label: string; subtitle?: string | null }>({
  title,
  options,
  selected,
  onToggle,
  searchable,
  onSearch,
}: {
  title: string;
  options: T[];
  selected: string[];
  onToggle: (id: string) => void;
  searchable?: boolean;
  onSearch?: (q: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const baseId = useId();
  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-inset ring-stroke-soft-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-9 w-full items-center justify-between gap-2 px-3 text-left outline-none transition hover:bg-bg-weak-50 focus-visible:bg-bg-weak-50"
      >
        <span className="text-label-sm text-text-strong-950">{title}</span>
        <span className="flex items-center gap-2">
          {selected.length > 0 && (
            <Badge.Root size="medium" variant="lighter" color="blue">
              已选 {selected.length} 项
            </Badge.Root>
          )}
          <RiArrowDownSLine className={cn("size-4 text-text-soft-400 transition-transform", open && "rotate-180")} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className="border-t border-stroke-soft-200">
          {searchable && (
            <div className="px-2 pt-2">
              <Input.Root size="xsmall">
                <Input.Wrapper>
                  <Input.Icon as={RiSearchLine} />
                  <Input.Input type="search" aria-label={`搜索${title}`} placeholder="搜索…" onChange={(e) => onSearch?.(e.target.value)} />
                </Input.Wrapper>
              </Input.Root>
            </div>
          )}
          <div className="max-h-44 overflow-y-auto p-1">
            {options.length === 0 && <p className="px-2 py-2 text-paragraph-xs text-text-soft-400">没有结果</p>}
            {options.map((opt) => {
              const id = `${baseId}-${opt.id}`;
              return (
                <label key={opt.id} htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition hover:bg-bg-weak-50">
                  <Checkbox.Root id={id} checked={selected.includes(opt.id)} onCheckedChange={() => onToggle(opt.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-paragraph-sm text-text-strong-950">{opt.label}</span>
                    {opt.subtitle && <span className="block truncate text-paragraph-xs text-text-soft-400">{opt.subtitle}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Master Inbox filters: a "Filter" button opening a popover of leads,
 * campaigns, mailboxes, lead status, status group and time. Changes are
 * staged and applied together with "Apply filters".
 */
export default function FilterPanel({
  value,
  onApply,
}: {
  value: InboxFilterState;
  onApply: (next: InboxFilterState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<InboxFilterState>(value);
  const [loaded, setLoaded] = useState(false);
  const [leads, setLeads] = useState<LeadOption[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [accounts, setAccounts] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<StatusOption[]>([]);
  const [timeMode, setTimeMode] = useState<TimeMode>(value.startDate ? "custom" : "all");

  useEffect(() => {
    if (!open || loaded) return;
    fetch("/api/outreach/inbox/filter-options")
      .then((r) => r.json())
      .then((data) => {
        setLeads(data.leads);
        setCampaigns(data.campaigns);
        setAccounts(data.accounts);
        setStatuses(data.statuses);
        setLoaded(true);
      })
      .catch(() => {});
  }, [open, loaded]);

  function onOpenChange(next: boolean) {
    // Each opening starts from what is applied; closing without Apply discards.
    if (next) {
      setDraft(value);
      setTimeMode(value.startDate ? "custom" : "all");
    }
    setOpen(next);
  }

  function toggle(field: "leadIds" | "campaignIds" | "accounts" | "statusKeys" | "statusGroups", id: string) {
    setDraft((prev) => ({
      ...prev,
      [field]: prev[field].includes(id) ? prev[field].filter((x) => x !== id) : [...prev[field], id],
    }));
  }

  function searchLeads(q: string) {
    fetch(`/api/outreach/inbox/filter-options?leadQuery=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((data) => setLeads(data.leads))
      .catch(() => {});
  }

  function applyTimeMode(mode: TimeMode) {
    setTimeMode(mode);
    const now = new Date();
    if (mode === "today") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      setDraft((p) => ({ ...p, startDate: start.toISOString(), endDate: now.toISOString() }));
    } else if (mode === "yesterday") {
      const start = new Date(now);
      start.setDate(now.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      setDraft((p) => ({ ...p, startDate: start.toISOString(), endDate: end.toISOString() }));
    } else if (mode === "all") {
      setDraft((p) => ({ ...p, startDate: null, endDate: null }));
    }
  }

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(value);

  return (
    <FilterPopover
      count={activeFilterCount(value)}
      open={open}
      onOpenChange={onOpenChange}
      onClear={() => {
        setDraft(EMPTY_FILTERS);
        setTimeMode("all");
      }}
      clearDisabled={!filtersActive(draft)}
      width="w-[min(34rem,calc(100vw-2rem))]"
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setOpen(false)}>
            取消
          </Button.Root>
          <Button.Root
            variant="primary"
            mode="filled"
            size="xsmall"
            disabled={!hasChanges}
            onClick={() => {
              onApply(draft);
              setOpen(false);
            }}
          >
            应用筛选
          </Button.Root>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <CollapsibleMultiSelect
            title="联系人"
            searchable
            onSearch={searchLeads}
            options={leads.map((l) => ({ id: l.id, label: l.name, subtitle: l.subtitle }))}
            selected={draft.leadIds}
            onToggle={(id) => toggle("leadIds", id)}
          />
          <CollapsibleMultiSelect
            title="营销活动"
            options={campaigns.map((c) => ({ id: c.id, label: c.name }))}
            selected={draft.campaignIds}
            onToggle={(id) => toggle("campaignIds", id)}
          />
          <CollapsibleMultiSelect
            title="发信邮箱"
            options={accounts.map((a) => ({ id: a, label: a }))}
            selected={draft.accounts}
            onToggle={(id) => toggle("accounts", id)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <CollapsibleMultiSelect
            title="线索状态"
            options={statuses.map((s) => ({ id: s.statusKey, label: s.label }))}
            selected={draft.statusKeys}
            onToggle={(id) => toggle("statusKeys", id)}
          />
          <CollapsibleMultiSelect
            title="状态分组"
            options={LEAD_STATUS_GROUPS.map((g) => ({ id: g.key, label: g.label }))}
            selected={draft.statusGroups}
            onToggle={(id) => toggle("statusGroups", id)}
          />
        </div>
      </div>

      <FilterField label="时间">
        <SegmentedControl.Root value={timeMode} onValueChange={(v) => applyTimeMode(v as TimeMode)}>
          <SegmentedControl.List>
            {TIME_MODES.map((mode) => (
              <SegmentedControl.Trigger key={mode.key} value={mode.key}>
                {mode.label}
              </SegmentedControl.Trigger>
            ))}
          </SegmentedControl.List>
        </SegmentedControl.Root>
        {timeMode === "custom" && (
          <div className="flex items-center gap-2 pt-1">
            <Input.Root size="xsmall" className="flex-1">
              <Input.Wrapper>
                <Input.Input
                  type="date"
                  aria-label="开始日期"
                  onChange={(e) => setDraft((p) => ({ ...p, startDate: e.target.value ? new Date(e.target.value).toISOString() : null }))}
                />
              </Input.Wrapper>
            </Input.Root>
            <span className="text-paragraph-xs text-text-soft-400">至</span>
            <Input.Root size="xsmall" className="flex-1">
              <Input.Wrapper>
                <Input.Input
                  type="date"
                  aria-label="结束日期"
                  onChange={(e) => setDraft((p) => ({ ...p, endDate: e.target.value ? new Date(e.target.value).toISOString() : null }))}
                />
              </Input.Wrapper>
            </Input.Root>
          </div>
        )}
      </FilterField>
    </FilterPopover>
  );
}

export { filtersActive };
