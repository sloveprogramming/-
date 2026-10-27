"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RiCalendarEventLine, RiCheckLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import { Callout, Field } from "@/components/settings/SettingsKit";

/**
 * 在客户记录页安排一次拜访。
 *
 * 改造新增。放在记录页而不是只放拜访页，是因为销售是在看这个客户的时候
 * 决定"下周去一趟"的——让他跳出去新建，多半就不建了。
 *
 * 提交后不弹成功页，直接跳转到拜访列表：他要确认的是"这周还有谁要见"，
 * 不是"我操作成功了"。
 */
export function ScheduleVisitButton({ recordId, companyName }: { recordId: string; companyName: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState(defaultSlot());
  const [location, setLocation] = useState("");
  const [purpose, setPurpose] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/visits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId,
          scheduledAt: new Date(scheduledAt).toISOString(),
          location: location || undefined,
          purpose: purpose || undefined,
        }),
      });
      const body = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "安排失败");
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
      <Button.Root
        variant="neutral"
        mode="stroke"
        size="xsmall"
        title="安排一次上门拜访"
        onClick={() => setOpen(true)}
      >
        <Button.Icon as={RiCalendarEventLine} />
        <span className="hidden sm:inline">安排拜访</span>
      </Button.Root>

      {open && (
        <Modal.Root open onOpenChange={(next) => { if (!next && !saving) { setOpen(false); setDone(false); } }}>
          <Modal.Content size="max-w-md" hideClose={saving}>
            <Modal.Header icon={RiCalendarEventLine}>
              <Modal.Title>安排拜访</Modal.Title>
              <Modal.Description>{companyName ?? "这个客户"}——见完之后回来结束拜访，写纪要。</Modal.Description>
            </Modal.Header>

            {done ? (
              <>
                <Modal.Body>
                  <div role="status" className="flex flex-col items-center gap-3 py-6 text-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-success-lighter">
                      <RiCheckLine className="size-6 text-success-base" aria-hidden="true" />
                    </span>
                    <p className="text-label-sm text-text-strong-950">已安排</p>
                    <p className="text-paragraph-sm text-text-sub-600">在「拜访」页可以看到所有待拜访的客户。</p>
                  </div>
                </Modal.Body>
                <Modal.Footer>
                  <Button.Root variant="neutral" mode="stroke" size="small" onClick={() => { setOpen(false); setDone(false); }}>关闭</Button.Root>
                  <Button.Root variant="primary" mode="filled" size="small" onClick={() => { setOpen(false); setDone(false); router.push("/visits"); }}>去拜访页</Button.Root>
                </Modal.Footer>
              </>
            ) : (
              <form onSubmit={submit} className="flex min-h-0 flex-col">
                <Modal.Body className="space-y-4">
                  <Field label="到访时间" htmlFor="visit-at" required description="按北京时间。">
                    <Input.Root size="medium">
                      <Input.Wrapper>
                        <Input.Input
                          id="visit-at"
                          type="datetime-local"
                          required
                          value={scheduledAt}
                          onChange={(e) => setScheduledAt(e.target.value)}
                        />
                      </Input.Wrapper>
                    </Input.Root>
                  </Field>
                  <Field label="地点" htmlFor="visit-place" optional description="对方公司地址，或约定的见面地点。">
                    <Input.Root size="medium">
                      <Input.Wrapper>
                        <Input.Input id="visit-place" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="杭州市临安区 XX 路 8 号" />
                      </Input.Wrapper>
                    </Input.Root>
                  </Field>
                  <Field label="这次的目的" htmlFor="visit-purpose" optional description="一句话，见完对照着写纪要。">
                    <Input.Root size="medium">
                      <Input.Wrapper>
                        <Input.Input id="visit-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="谈区域代理，带样品" />
                      </Input.Wrapper>
                    </Input.Root>
                  </Field>
                  {error && <Callout tone="error" title="安排失败">{error}</Callout>}
                </Modal.Body>
                <Modal.Footer>
                  <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={() => setOpen(false)} disabled={saving}>取消</Button.Root>
                  <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!scheduledAt || saving}>
                    {saving ? "保存中…" : "安排"}
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

/** 默认填后天上午 10 点——比"现在"更可能是真的拜访时间。 */
function defaultSlot(): string {
  const date = new Date();
  date.setDate(date.getDate() + 2);
  date.setHours(10, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
