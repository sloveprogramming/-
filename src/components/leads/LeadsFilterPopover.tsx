"use client";

import { RiFilter3Line } from "@remixicon/react";
import * as Badge from "@/components/alignui/badge";
import * as Button from "@/components/alignui/button";
import * as Checkbox from "@/components/alignui/checkbox";
import * as Popover from "@/components/alignui/popover";
import * as Select from "@/components/alignui/select";
import { crmCategoryLabel, crmWorkflowStateLabel } from "@/lib/crm/labels";
import { activeFilterCount, type PeopleFilters } from "./leadTypes";

export type Subcategory = { id: string; name: string; categoryKey: string };

const STATES = ["unclassified", "classifying", "action_required", "waiting", "idle", "paused", "closed", "error"];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><span className="block text-label-xs text-text-sub-600">{label}</span>{children}</div>;
}

function Check({ id, label, checked, onChange }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-paragraph-sm text-text-strong-950">
      <Checkbox.Root id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {label}
    </label>
  );
}

/**
 * 线索筛选。
 *
 * 改造：中文化，并去掉 LinkedIn / 邮件两个已合并的渠道选项——现在只有邮件活动，
 * 所以「活动」一栏只剩「全部 / 邮件活动 / 未加入活动」。分类与处理状态取
 * lib/crm/labels 的同一份词表。
 */
export function LeadsFilterPopover({ filters, subcategories, onChange, onClear }: {
  filters: PeopleFilters;
  subcategories: Subcategory[];
  onChange: (patch: Partial<PeopleFilters>) => void;
  onClear: () => void;
}) {
  const count = activeFilterCount(filters);
  const visibleSubcategories = subcategories.filter((item) => !filters.crmCategory || item.categoryKey === filters.crmCategory);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button.Root variant="neutral" mode="stroke" size="small">
          <Button.Icon as={RiFilter3Line} />
          筛选
          {count > 0 && <Badge.Root size="medium" variant="filled" color="blue" square>{count}</Badge.Root>}
        </Button.Root>
      </Popover.Trigger>
      <Popover.Content align="end" showArrow={false} sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="flex items-center justify-between">
          <h2 className="text-label-md text-text-strong-950">筛选条件</h2>
          <button type="button" onClick={onClear} disabled={!count} className="text-label-sm text-primary-base outline-none hover:underline focus-visible:underline disabled:pointer-events-none disabled:text-text-disabled-300">清空</button>
        </div>
        <div className="mt-4 space-y-4">
          <Field label="所在活动">
            <Select.Root size="small" value={filters.campaignChannel} onValueChange={(value) => onChange({ campaignChannel: value })}>
              <Select.Trigger aria-label="活动筛选"><Select.Value placeholder="全部活动" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">全部活动</Select.Item>
                <Select.Item value="email">邮件活动</Select.Item>
                <Select.Item value="unassigned">未加入活动</Select.Item>
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="CRM 分类">
            <Select.Root size="small" value={filters.crmCategory} onValueChange={(value) => onChange({ crmCategory: value, crmSubcategoryId: "" })}>
              <Select.Trigger aria-label="CRM 分类筛选"><Select.Value placeholder="全部分类" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">全部分类</Select.Item>
                <Select.Item value="customer">{crmCategoryLabel("customer")}</Select.Item>
                <Select.Item value="interested">{crmCategoryLabel("interested")}</Select.Item>
                <Select.Item value="not_interested">{crmCategoryLabel("not_interested")}</Select.Item>
                <Select.Item value="other">{crmCategoryLabel("other")}</Select.Item>
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="子分类">
            <Select.Root size="small" value={filters.crmSubcategoryId} onValueChange={(value) => onChange({ crmSubcategoryId: value })} disabled={!visibleSubcategories.length}>
              <Select.Trigger aria-label="CRM 子分类筛选"><Select.Value placeholder="全部子分类" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">全部子分类</Select.Item>
                {visibleSubcategories.map((item) => <Select.Item key={item.id} value={item.id}>{item.name}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </Field>
          <Field label="处理状态">
            <Select.Root size="small" value={filters.crmWorkflowState} onValueChange={(value) => onChange({ crmWorkflowState: value })}>
              <Select.Trigger aria-label="CRM 状态筛选"><Select.Value placeholder="全部状态" /></Select.Trigger>
              <Select.Content>
                <Select.Item value="">全部状态</Select.Item>
                {STATES.map((state) => <Select.Item key={state} value={state}>{crmWorkflowStateLabel(state)}</Select.Item>)}
              </Select.Content>
            </Select.Root>
          </Field>
          <div className="space-y-3 border-t border-stroke-soft-200 pt-4">
            <Check id="lead-filter-has-email" label="有邮箱" checked={filters.hasEmail} onChange={(hasEmail) => onChange({ hasEmail })} />
            <Check id="lead-filter-has-linkedin" label="有领英主页" checked={filters.hasLinkedin} onChange={(hasLinkedin) => onChange({ hasLinkedin })} />
            <Check id="lead-filter-ai-change" label="AI 改过分类" checked={filters.crmAiChange} onChange={(crmAiChange) => onChange({ crmAiChange })} />
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
