"use client";

import { useState } from "react";
import { RiPhoneLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Modal from "@/components/alignui/modal";
import * as Select from "@/components/alignui/select";
import * as Textarea from "@/components/alignui/textarea";
import { Callout, Field } from "@/components/settings/SettingsKit";
import {
  CALL_INTENT_LABEL,
  CALL_OUTCOME_LABEL,
  CALL_OUTCOMES,
  coerceIntent,
  intentsFor,
  validateCallLog,
  type CallIntent,
  type CallOutcome,
} from "@/lib/crm/callTypes";

/**
 * 记录一次通话结果。
 *
 * 这是"营销动作"和"CRM 跟踪"的接口：销售打完电话，在这里写一句，记录上就
 * 有了这次接触。之后 AI 起草跟进时有据可依——否则它只知道"我们发过邮件"，
 * 不知道"上周打过电话，对方说在对比供应商"。
 *
 * 表单设计上的两个约束，都是有意的：
 * - **结果决定能选哪些意向**：没接通不能标"有意向"，明确拒绝只能选"无意向"。
 *   这防止的是销售为了图快乱点，最后统计出来全是"有意向"。
 * - **要点不是必填，但空着会提示**：强制必填会让人写"无"，不如让它可选，
 *   但界面提醒"写一句，下次打电话你就想起来了"。
 */
export function LogCallDialog({
  recordId,
  companyName,
  phone,
}: {
  recordId: string;
  companyName: string | null;
  phone: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<CallOutcome>("connected");
  const [intent, setIntent] = useState<CallIntent>("interested");
  const [notes, setNotes] = useState("");
  const [nextStep, setNextStep] = useState("");
  const [contactName, setContactName] = useState("");
  const [duration, setDuration] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const localError = validateCallLog({ outcome, intent, notes });

  function changeOutcome(next: CallOutcome) {
    setOutcome(next);
    // 结果变了，原来选的意向可能不再合法（比如"拒绝"只能选"无意向"）。
    setIntent((current) => coerceIntent(next, current));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (localError) {
      setError(localError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/crm/calls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId,
          outcome,
          intent,
          notes,
          nextStep: nextStep || undefined,
          contactName: contactName || undefined,
          durationSeconds: duration ? Number(duration) : undefined,
        }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "保存失败");
        return;
      }
      setDone(true);
    } catch {
      setError("网络请求失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => setOpen(true)}>
        <Button.Icon as={RiPhoneLine} />
        <span className="hidden sm:inline">记录通话</span>
      </Button.Root>

      {open && (
        <Modal.Root open onOpenChange={(next) => { if (!next && !saving) { setOpen(false); setDone(false); } }}>
          <Modal.Content size="max-w-lg" hideClose={saving}>
            <Modal.Header icon={RiPhoneLine}>
              <Modal.Title>记录通话结果</Modal.Title>
              <Modal.Description>
                {companyName ?? "这个客户"}{phone ? ` · ${phone}` : ""}
              </Modal.Description>
            </Modal.Header>

            {done ? (
              <>
                <Modal.Body>
                  <div role="status" className="flex flex-col items-center gap-2 py-6 text-center">
                    <p className="text-label-sm text-text-strong-950">已记录</p>
                    <p className="text-paragraph-sm text-text-sub-600">这次接触会进到时间线，AI 起草跟进时会看到。</p>
                  </div>
                </Modal.Body>
                <Modal.Footer>
                  <Button.Root variant="primary" mode="filled" size="small" onClick={() => { setOpen(false); setDone(false); }}>关闭</Button.Root>
                </Modal.Footer>
              </>
            ) : (
              <form onSubmit={submit} className="flex min-h-0 flex-col">
                <Modal.Body className="space-y-4">
                  <Field label="结果" htmlFor="call-outcome" required>
                    <Select.Root size="small" value={outcome} onValueChange={(value) => changeOutcome(value as CallOutcome)}>
                      <Select.Trigger aria-label="通话结果"><Select.Value /></Select.Trigger>
                      <Select.Content>
                        {CALL_OUTCOMES.map((key) => (
                          <Select.Item key={key} value={key}>{CALL_OUTCOME_LABEL[key]}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Field>

                  <Field
                    label="意向"
                    htmlFor="call-intent"
                    required
                    description={outcome === "unreachable" ? "没接通就无法判断意向，只能选「说不清」。" : "按对方的态度判断，不用太纠结。"}
                  >
                    <Select.Root size="small" value={intent} onValueChange={(value) => setIntent(value as CallIntent)}>
                      <Select.Trigger aria-label="意向"><Select.Value /></Select.Trigger>
                      <Select.Content>
                        {intentsFor(outcome).map((key) => (
                          <Select.Item key={key} value={key}>{CALL_INTENT_LABEL[key]}</Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  </Field>

                  <Field label="通话要点" htmlFor="call-notes" optional description="写一句就行。不写的话，下次打过去你就想不起这次说过什么了。">
                    <Textarea.Root
                      id="call-notes"
                      simple
                      rows={3}
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="转了采购王经理，说下周三给答复；他现在用别家的，嫌贵"
                    />
                  </Field>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="对方怎么称呼" htmlFor="call-name" optional description="填了就能改掉「前台」这个临时称呼。">
                      <input
                        id="call-name"
                        value={contactName}
                        onChange={(event) => setContactName(event.target.value)}
                        placeholder="王经理"
                        className="w-full rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-stroke-strong-950"
                      />
                    </Field>
                    <Field label="通话时长（秒）" htmlFor="call-duration" optional>
                      <input
                        id="call-duration"
                        type="number"
                        min={0}
                        value={duration}
                        onChange={(event) => setDuration(event.target.value)}
                        placeholder="120"
                        className="w-full rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-stroke-strong-950"
                      />
                    </Field>
                  </div>

                  <Field label="下一步" htmlFor="call-next" optional>
                    <input
                      id="call-next"
                      value={nextStep}
                      onChange={(event) => setNextStep(event.target.value)}
                      placeholder="周三回电；先寄样品"
                      className="w-full rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-stroke-strong-950"
                    />
                  </Field>

                  {(error || localError) && (
                    <Callout tone="error" title="还不能保存">{error ?? localError}</Callout>
                  )}
                </Modal.Body>
                <Modal.Footer>
                  <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={saving} onClick={() => setOpen(false)}>取消</Button.Root>
                  <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={saving || Boolean(localError)}>
                    {saving ? "保存中…" : "保存"}
                  </Button.Root>
                </Modal.Footer>
              </form>
            )}
          </Modal.Content>
        </Modal.Root>
      )}
    </>
  );
}
