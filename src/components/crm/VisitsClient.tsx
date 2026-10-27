"use client";

import { useCallback, useEffect, useState } from "react";
import { RiCalendarEventLine, RiCheckLine, RiCloseLine, RiLoader4Line, RiMapPinLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { Callout, Field } from "@/components/settings/SettingsKit";
import { cn } from "@/utils/cn";
import { VISIT_OUTCOME_LABEL, VISIT_STATUS_LABEL, type Visit, type VisitOutcome, type VisitStatus } from "@/lib/crm/visitTypes";

/**
 * 拜访列表：谁要去见谁、什么时候、现在到哪一步。
 *
 * 改造新增。销售最常用的两个动作直接放在行上：到场签到、结束并写纪要。
 * 结束拜访时纪要必填——没有纪要的拜访等于没发生，这是业务规则，不是表单洁癖。
 */

type Props = { initialVisits: Visit[] };

const STATUS_TONE: Record<VisitStatus, string> = {
  planned: "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200",
  checked_in: "bg-information-lighter text-information-dark ring-information-light",
  completed: "bg-success-lighter text-success-dark ring-success-light",
  cancelled: "bg-bg-weak-50 text-text-soft-400 ring-stroke-soft-200",
};

export function VisitsClient({ initialVisits }: Props) {
  const [visits, setVisits] = useState<Visit[]>(initialVisits);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Visit | null>(null);

  const reload = useCallback(async () => {
    const response = await fetch("/api/visits", { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { visits?: Visit[] };
    setVisits(body.visits ?? []);
  }, []);

  async function act(visitId: string, action: "check_in" | "cancel", extra: Record<string, unknown> = {}) {
    setBusy(visitId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/visits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId, action, ...extra }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "操作失败");
        return;
      }
      setNotice(action === "check_in" ? "已签到" : "已取消");
      await reload();
    } catch {
      setError("网络请求失败");
    } finally {
      setBusy(null);
    }
  }

  const upcoming = visits.filter((visit) => visit.status === "planned" || visit.status === "checked_in");
  const finished = visits.filter((visit) => visit.status === "completed" || visit.status === "cancelled");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader
        title="拜访"
        description="安排见客户、到场签到、见完写纪要。结束拜访后记得把记录推进到「已见面」。"
      />

      {error && <Callout tone="error" title="出错了">{error}</Callout>}
      {notice && <Callout tone="success" title="完成">{notice}</Callout>}

      <Section title={`待拜访（${upcoming.length}）`}>
        {upcoming.length === 0 ? (
          <EmptyState
            icon={RiCalendarEventLine}
            title="近期没有安排"
            description="在客户记录页点「安排拜访」即可。"
          />
        ) : (
          <div className="divide-y divide-stroke-soft-200">
            {upcoming.map((visit) => (
              <VisitRow
                key={visit.id}
                visit={visit}
                busy={busy === visit.id}
                onCheckIn={() => void act(visit.id, "check_in")}
                onCancel={() => void act(visit.id, "cancel", { reason: "销售取消" })}
                onComplete={() => setCompleting(visit)}
              />
            ))}
          </div>
        )}
      </Section>

      {finished.length > 0 && (
        <Section title={`已结束（${finished.length}）`}>
          <div className="divide-y divide-stroke-soft-200">
            {finished.map((visit) => <VisitRow key={visit.id} visit={visit} busy={false} />)}
          </div>
        </Section>
      )}

      {completing && (
        <CompleteVisitDialog
          visit={completing}
          onClose={() => setCompleting(null)}
          onDone={async () => {
            setCompleting(null);
            setNotice("拜访已结束");
            await reload();
          }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
      <h2 className="border-b border-stroke-soft-200 px-4 py-3 text-label-sm text-text-strong-950">{title}</h2>
      <div className="px-4">{children}</div>
    </section>
  );
}

function VisitRow({
  visit,
  busy,
  onCheckIn,
  onCancel,
  onComplete,
}: {
  visit: Visit;
  busy: boolean;
  onCheckIn?: () => void;
  onCancel?: () => void;
  onComplete?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("inline-flex h-6 items-center rounded-md px-2 text-label-xs ring-1 ring-inset", STATUS_TONE[visit.status])}>
            {VISIT_STATUS_LABEL[visit.status]}
          </span>
          <span className="truncate text-label-sm text-text-strong-950">
            {visit.companyName ?? visit.personName ?? "未知客户"}
          </span>
          {visit.personName && visit.companyName && (
            <span className="truncate text-paragraph-xs text-text-soft-400">{visit.personName}</span>
          )}
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-paragraph-xs text-text-sub-600">
          {visit.scheduledAt && (
            <span className="inline-flex items-center gap-1">
              <RiCalendarEventLine className="size-3.5" />
              {formatTime(visit.scheduledAt)}
            </span>
          )}
          {visit.location && (
            <span className="inline-flex items-center gap-1">
              <RiMapPinLine className="size-3.5" />
              {visit.location}
            </span>
          )}
          {visit.purpose && <span>目的：{visit.purpose}</span>}
        </p>
        {visit.status === "completed" && visit.notes && (
          <p className="mt-1 line-clamp-2 text-paragraph-xs text-text-soft-400">纪要：{visit.notes}</p>
        )}
        {visit.status === "completed" && visit.outcome && (
          <p className="mt-0.5 text-paragraph-xs text-text-sub-600">结果：{VISIT_OUTCOME_LABEL[visit.outcome]}
            {visit.nextStep ? ` · 下一步：${visit.nextStep}` : ""}
          </p>
        )}
        {visit.status === "cancelled" && visit.cancelledReason && (
          <p className="mt-0.5 text-paragraph-xs text-text-soft-400">取消原因：{visit.cancelledReason}</p>
        )}
      </div>

      {visit.status === "planned" && onCheckIn && (
        <div className="flex shrink-0 gap-2">
          <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={onCheckIn}>
            {busy ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiCheckLine} />}
            签到
          </Button.Root>
          <Button.Root variant="neutral" mode="ghost" size="xsmall" disabled={busy} onClick={onCancel}>
            <Button.Icon as={RiCloseLine} />
            取消
          </Button.Root>
        </div>
      )}
      {visit.status === "checked_in" && onComplete && (
        <Button.Root variant="primary" mode="filled" size="xsmall" className="shrink-0" onClick={onComplete}>
          结束并写纪要
        </Button.Root>
      )}
    </div>
  );
}

function CompleteVisitDialog({ visit, onClose, onDone }: { visit: Visit; onClose: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [outcome, setOutcome] = useState<VisitOutcome>("advanced");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/visits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitId: visit.id, action: "complete", notes, nextStep, outcome }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "保存失败");
        return;
      }
      onDone();
    } catch {
      setError("网络请求失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <Modal.Content size="max-w-lg" hideClose={saving}>
        <Modal.Header icon={RiCalendarEventLine}>
          <Modal.Title>结束拜访</Modal.Title>
          <Modal.Description>{visit.companyName ?? visit.personName ?? "这次拜访"}——见完立刻写，过一天就只剩模糊印象。</Modal.Description>
        </Modal.Header>
        <form onSubmit={submit} className="flex min-h-0 flex-col">
          <Modal.Body className="space-y-4">
            <Field label="见面纪要" htmlFor="visit-notes" required description="谈了什么、对方什么态度、卡在哪。">
              <Textarea.Root id="visit-notes" simple rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="见了采购王总，对山核桃仁感兴趣，主要顾虑是首批起订量和账期。" />
            </Field>
            <Field label="下一步" htmlFor="visit-next" optional description="谁、做什么、什么时候。">
              <Input.Root size="medium">
                <Input.Wrapper>
                  <Input.Input id="visit-next" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="周三前发正式报价单和样品" />
                </Input.Wrapper>
              </Input.Root>
            </Field>
            <Field label="结果" htmlFor="visit-outcome" required>
              <Select.Root size="small" value={outcome} onValueChange={(value) => setOutcome(value as VisitOutcome)}>
                <Select.Trigger aria-label="拜访结果"><Select.Value /></Select.Trigger>
                <Select.Content>
                  {(Object.keys(VISIT_OUTCOME_LABEL) as VisitOutcome[]).map((key) => (
                    <Select.Item key={key} value={key}>{VISIT_OUTCOME_LABEL[key]}</Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Field>
            {error && <Callout tone="error" title="保存失败">{error}</Callout>}
          </Modal.Body>
          <Modal.Footer>
            <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose} disabled={saving}>取消</Button.Root>
            <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!notes.trim() || saving}>
              {saving ? "保存中…" : "保存"}
            </Button.Root>
          </Modal.Footer>
        </form>
      </Modal.Content>
    </Modal.Root>
  );
}

/** 北京时间，精确到分钟——拜访安排不需要秒。 */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
