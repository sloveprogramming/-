"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RiCheckLine, RiLoader4Line, RiMailAddLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Modal from "@/components/alignui/modal";
import * as Textarea from "@/components/alignui/textarea";
import { Callout, Field } from "@/components/settings/SettingsKit";

type Stage = "form" | "testing" | "success" | "failed";
type Mode = "smtp" | "google";

/**
 * 添加发信邮箱。
 *
 * 改造：默认走企业邮箱 SMTP（腾讯企业邮 / 阿里云 / 网易企业邮），因为国内没有
 * Google Workspace 这条路。Google Workspace 保留成第二个选项，给已经有
 * 域委派的老部署用。
 *
 * 密码只在这里出现一次，提交后服务端加密入库，再也不会读回来。
 */

const PRESETS = [
  { label: "腾讯企业邮", host: "smtp.exmail.qq.com", port: 465, secure: true },
  { label: "阿里云邮箱", host: "smtp.qiye.aliyun.com", port: 465, secure: true },
  { label: "网易企业邮", host: "smtphz.qiye.163.com", port: 465, secure: true },
  { label: "587 STARTTLS", host: "", port: 587, secure: false },
] as const;

export default function ConnectMailboxDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("smtp");
  const [emailAddress, setEmailAddress] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [signatureHtml, setSignatureHtml] = useState("");
  const [host, setHost] = useState<string>(PRESETS[0].host);
  const [port, setPort] = useState<number>(PRESETS[0].port);
  const [secure, setSecure] = useState<boolean>(PRESETS[0].secure);
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [stage, setStage] = useState<Stage>("form");
  const [error, setError] = useState<string | null>(null);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setStage("testing");
    setError(null);
    try {
      const res = await fetch("/api/outreach/mailboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "smtp"
            ? {
                provider: "smtp",
                emailAddress,
                displayName: displayName || undefined,
                signatureHtml: signatureHtml || undefined,
                host,
                port,
                secure,
                user: user || emailAddress,
                secret,
              }
            : { emailAddress, displayName: displayName || undefined, signatureHtml: signatureHtml || undefined },
        ),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setError(data.error ?? "邮箱保存失败");
        setStage("failed");
        return;
      }
      setStage("success");
      router.refresh();
    } catch {
      setError("网络请求失败，请重试");
      setStage("failed");
    }
  }

  const testing = stage === "testing";
  const canSubmit = Boolean(emailAddress) && (mode === "google" || (Boolean(host) && Boolean(secret)));

  return (
    <Modal.Root open onOpenChange={(open) => { if (!open && !testing) onClose(); }}>
      <Modal.Content size="max-w-lg" hideClose={testing} onEscapeKeyDown={(event) => testing && event.preventDefault()}>
        <Modal.Header icon={RiMailAddLine}>
          <Modal.Title>添加发信邮箱</Modal.Title>
          <Modal.Description>
            外发活动从这里配置的邮箱发出。企业邮箱会先真发一次登录验证，验不过不会保存成可用状态。
          </Modal.Description>
        </Modal.Header>

        {(stage === "form" || stage === "failed") && (
          <form onSubmit={handleConnect} className="flex min-h-0 flex-col">
            <Modal.Body className="space-y-4">
              <div className="flex gap-2">
                {([
                  { key: "smtp" as const, label: "企业邮箱（SMTP）" },
                  { key: "google" as const, label: "Google Workspace" },
                ]).map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setMode(option.key)}
                    className={
                      mode === option.key
                        ? "rounded-lg bg-bg-weak-50 px-3 py-1.5 text-label-sm text-text-strong-950 ring-1 ring-inset ring-stroke-strong-950"
                        : "rounded-lg px-3 py-1.5 text-label-sm text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50"
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <Field
                label="邮箱地址"
                htmlFor="mailbox-email"
                required
                description={mode === "smtp" ? "完整地址，用来发信和收信。" : "必须在 Workspace 管理后台对本应用的 client ID 授权过（域委派）。"}
              >
                <Input.Root size="medium">
                  <Input.Wrapper>
                    <Input.Input
                      id="mailbox-email"
                      type="email"
                      required
                      autoFocus
                      value={emailAddress}
                      onChange={(e) => setEmailAddress(e.target.value)}
                      placeholder="xiaoshou@xinnongge.com"
                    />
                  </Input.Wrapper>
                </Input.Root>
              </Field>

              {mode === "smtp" && (
                <>
                  <div>
                    <p className="mb-1.5 text-label-sm text-text-strong-950">服务商</p>
                    <div className="flex flex-wrap gap-2">
                      {PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          onClick={() => {
                            if (preset.host) setHost(preset.host);
                            setPort(preset.port);
                            setSecure(preset.secure);
                          }}
                          className={
                            port === preset.port && (preset.host === "" || host === preset.host)
                              ? "rounded-lg bg-bg-weak-50 px-2.5 py-1 text-paragraph-xs text-text-strong-950 ring-1 ring-inset ring-stroke-strong-950"
                              : "rounded-lg px-2.5 py-1 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50"
                          }
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <Field label="SMTP 服务器" htmlFor="mailbox-host" required>
                        <Input.Root size="medium">
                          <Input.Wrapper>
                            <Input.Input
                              id="mailbox-host"
                              type="text"
                              required
                              value={host}
                              onChange={(e) => setHost(e.target.value)}
                              placeholder="smtp.exmail.qq.com"
                            />
                          </Input.Wrapper>
                        </Input.Root>
                      </Field>
                    </div>
                    <Field label="端口" htmlFor="mailbox-port" required description={secure ? "SSL 直连" : "STARTTLS"}>
                      <Input.Root size="medium">
                        <Input.Wrapper>
                          <Input.Input
                            id="mailbox-port"
                            type="number"
                            required
                            value={port}
                            onChange={(e) => {
                              const next = Number(e.target.value);
                              setPort(next);
                              setSecure(next === 465);
                            }}
                          />
                        </Input.Wrapper>
                      </Input.Root>
                    </Field>
                  </div>

                  <Field label="账号" htmlFor="mailbox-user" optional description="一般就是邮箱地址本身；留空则用上面的地址。">
                    <Input.Root size="medium">
                      <Input.Wrapper>
                        <Input.Input
                          id="mailbox-user"
                          type="text"
                          value={user}
                          onChange={(e) => setUser(e.target.value)}
                          placeholder="xiaoshou@xinnongge.com"
                        />
                      </Input.Wrapper>
                    </Input.Root>
                  </Field>

                  <Field
                    label="密码"
                    htmlFor="mailbox-secret"
                    required
                    description="国内企业邮箱多数要单独开启 SMTP 服务，并用「客户端专用密码」，不是登录密码。保存后加密入库，不会再显示。"
                  >
                    <Input.Root size="medium">
                      <Input.Wrapper>
                        <Input.Input
                          id="mailbox-secret"
                          type="password"
                          required
                          autoComplete="new-password"
                          value={secret}
                          onChange={(e) => setSecret(e.target.value)}
                        />
                      </Input.Wrapper>
                    </Input.Root>
                  </Field>
                </>
              )}

              <Field label="显示名" htmlFor="mailbox-name" optional description="收件人看到的名字，写在地址旁边。">
                <Input.Root size="medium">
                  <Input.Wrapper>
                    <Input.Input
                      id="mailbox-name"
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="新农哥 · 王经理"
                    />
                  </Input.Wrapper>
                </Input.Root>
              </Field>

              <Field label="签名" htmlFor="mailbox-signature" optional description="每封从这个邮箱发出的信都会附上。之后可以在邮箱的「签名」里改。">
                <Textarea.Root
                  id="mailbox-signature"
                  simple
                  value={signatureHtml}
                  onChange={(e) => setSignatureHtml(e.target.value)}
                  placeholder={"王经理\n新农哥 · 华东区渠道"}
                  rows={3}
                />
              </Field>

              {stage === "failed" && error && (
                <Callout tone="error" title="连接测试没通过">
                  {error}
                </Callout>
              )}
            </Modal.Body>

            <Modal.Footer>
              <Button.Root type="button" variant="neutral" mode="stroke" size="small" onClick={onClose}>
                取消
              </Button.Root>
              <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={!canSubmit}>
                {stage === "failed" ? "重试" : "连接并测试"}
              </Button.Root>
            </Modal.Footer>
          </form>
        )}

        {testing && (
          <Modal.Body>
            <div role="status" className="flex flex-col items-center justify-center gap-3 py-10 text-center">
              <RiLoader4Line className="size-6 animate-spin text-text-sub-600" aria-hidden="true" />
              <p className="text-paragraph-sm text-text-sub-600">正在连接 {emailAddress}…</p>
            </div>
          </Modal.Body>
        )}

        {stage === "success" && (
          <>
            <Modal.Body>
              <div role="status" className="flex flex-col items-center justify-center gap-3 py-6 text-center">
                <span className="flex size-12 items-center justify-center rounded-full bg-success-lighter">
                  <RiCheckLine className="size-6 text-success-base" aria-hidden="true" />
                </span>
                <div>
                  <p className="text-label-sm text-text-strong-950">邮箱已连接</p>
                  <p className="mt-0.5 text-paragraph-sm text-text-sub-600">{emailAddress} 已经可以发信了。</p>
                </div>
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button.Root variant="primary" mode="filled" size="small" onClick={onClose}>
                完成
              </Button.Root>
            </Modal.Footer>
          </>
        )}
      </Modal.Content>
    </Modal.Root>
  );
}
