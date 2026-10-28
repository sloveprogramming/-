"use client";

import { useCallback, useMemo, useState } from "react";
import { RiFileCopyLine, RiLoader4Line, RiPhoneLine, RiSearchLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { Callout } from "@/components/settings/SettingsKit";
import { cn } from "@/utils/cn";
import type { ProductIntent } from "@/lib/icp/productIntent";
import { buildCallScript, renderCallScriptText } from "@/lib/icp/callScript";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * 产品驱动的电话工作台。
 *
 * 销售的真实场景：拿到一个新产品（面包丝），不知道卖给谁、不知道打给谁、
 * 不知道第一句说什么。这个页面把这四步做成一屏：
 *
 *   输产品 → 看系统推断的买家类型 → 拿到公司和电话 → 复制话术去打电话 → 记录结果
 *
 * 设计取舍：
 * - 话术按公司逐个生成，不是一条通用稿——不同客户类型开场完全不同。
 * - 电话优先展示，因为这是国内最有效的首触；企微/邮件是备选。
 * - 「记结果」写进浏览器本地，不落库：这一版是给人手工打电话用的，
 *   真要把结果进 CRM，应该走「加入线索库 → 记录页」那条已经有审计的路径。
 */

type ProductSearchResponse = {
  source: "local" | "qcc";
  total: number;
  hits: CompanyHit[];
  notice: string | null;
  intent: ProductIntent;
  perTerm: Array<{ term: string; hits: number; error?: string }>;
};

export function PhoneWorkbenchClient({ qccEnabled, repName }: { qccEnabled: boolean; repName: string | null }) {
  const [product, setProduct] = useState("");
  const [result, setResult] = useState<ProductSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CompanyHit | null>(null);
  const [callNotes, setCallNotes] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const search = useCallback(async (term: string) => {
    if (!term.trim()) return;
    setSearching(true);
    setError(null);
    setSelected(null);
    try {
      const response = await fetch(`/api/prospecting/search?product=${encodeURIComponent(term.trim())}`);
      const body = (await response.json()) as ProductSearchResponse & { error?: string };
      if (!response.ok || body.error) {
        setError(body.error ?? "搜索失败");
        setResult(null);
        return;
      }
      setResult(body);
    } catch {
      setError("网络请求失败");
      setResult(null);
    } finally {
      setSearching(false);
    }
  }, []);

  const script = useMemo(() => {
    if (!selected || !result) return null;
    return buildCallScript({
      product: result.intent,
      companyName: selected.name,
      contactName: null,
      repName,
    });
  }, [selected, result, repName]);

  const scriptText = useMemo(
    () => (script ? renderCallScriptText(script, { rep: repName }) : ""),
    [script, repName],
  );

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板被浏览器拒绝时不做任何事——用户还能手动选中复制。
    }
  }

  const withPhone = result?.hits.filter((hit) => hit.phones.length > 0) ?? [];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader
        title="电话名单"
        description="输入一个产品，系统推断谁会买、去哪儿找，并给每家公司一份电话话术。"
      />

      <div className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
        <form
          onSubmit={(event) => { event.preventDefault(); void search(product); }}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <Input.Root size="medium" className="flex-1">
            <Input.Wrapper>
              <Input.Icon as={RiSearchLine} />
              <Input.Input
                value={product}
                onChange={(event) => setProduct(event.target.value)}
                placeholder="产品名，比如「面包丝」「山核桃仁」「年货礼盒」"
                aria-label="产品名"
              />
            </Input.Wrapper>
          </Input.Root>
          <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={searching || !product.trim()}>
            {searching ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <RiSearchLine className="size-4" />}
            找客户
          </Button.Root>
        </form>
        <p className="mt-3 text-paragraph-xs text-text-soft-400">
          {qccEnabled
            ? "已接入企查查：搜的是全国企业的工商信息与公示电话。"
            : "当前只在本地线索库里搜。配置 QCC_APP_KEY 后可以搜全国企业。"}
        </p>
      </div>

      {error && <Callout tone="error" title="出错了">{error}</Callout>}

      {result && (
        <>
          <IntentCard result={result} />

          {withPhone.length === 0 ? (
            <EmptyState
              icon={RiPhoneLine}
              title="没有找到带电话的公司"
              description={
                result.total > 0
                  ? `搜到 ${result.total} 家公司，但都没有公示电话。可以换一个产品词，或把这些公司先加进线索库再用企微/邮件联系。`
                  : "没有搜到公司。换个说法试试，比如用更通用的品类词。"
              }
            />
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
                <div className="flex items-center justify-between border-b border-stroke-soft-200 px-4 py-3">
                  <p className="text-label-sm text-text-strong-950">
                    可打电话（{withPhone.length}）
                  </p>
                </div>
                <ul className="max-h-[32rem] divide-y divide-stroke-soft-200 overflow-y-auto">
                  {withPhone.map((hit) => (
                    <li key={hit.key}>
                      <button
                        type="button"
                        onClick={() => setSelected(hit)}
                        className={cn(
                          "flex w-full flex-col gap-1 px-4 py-3 text-left transition hover:bg-bg-weak-50",
                          selected?.key === hit.key && "bg-bg-weak-50",
                        )}
                      >
                        <span className="truncate text-label-sm text-text-strong-950">{hit.name}</span>
                        <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-paragraph-xs text-text-sub-600">
                          <span className="inline-flex items-center gap-1 text-text-strong-950">
                            <RiPhoneLine className="size-3.5" />
                            {hit.phones[0]}
                          </span>
                          {hit.region && <span>{hit.region}</span>}
                          {hit.industry && <span>{hit.industry}</span>}
                        </span>
                        {callNotes[hit.key] && (
                          <span className="truncate text-paragraph-xs text-text-soft-400">记录：{callNotes[hit.key]}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
                {!selected || !script ? (
                  <p className="py-12 text-center text-paragraph-sm text-text-soft-400">
                    左边选一家公司，这里会给出针对它的电话话术
                  </p>
                ) : (
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-label-md text-text-strong-950">{selected.name}</p>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-paragraph-xs text-text-sub-600">
                          <a href={`tel:${selected.phones[0]}`} className="inline-flex items-center gap-1 text-text-strong-950 hover:underline">
                            <RiPhoneLine className="size-3.5" />
                            {selected.phones[0]}
                          </a>
                          {selected.phones.length > 1 && <span>另有 {selected.phones.length - 1} 个号码</span>}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button.Root variant="neutral" mode="stroke" size="xsmall" onClick={() => void copy(scriptText, "script")}>
                          <Button.Icon as={RiFileCopyLine} />
                          {copied === "script" ? "已复制" : "复制话术"}
                        </Button.Root>
                        <Button.Root asChild variant="primary" mode="filled" size="xsmall">
                          <a href={`tel:${selected.phones[0]}`}>
                            <RiPhoneLine className="size-4" />
                            拨号
                          </a>
                        </Button.Root>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      {script.segments.map((part) => (
                        <div key={part.key} className="rounded-lg bg-bg-weak-50 p-3">
                          <p className="flex items-baseline justify-between gap-2">
                            <span className="text-label-sm text-text-strong-950">{part.label}</span>
                            <span className="text-paragraph-xs text-text-soft-400">约 {part.seconds} 秒</span>
                          </p>
                          <p className="mt-1.5 whitespace-pre-line text-paragraph-sm text-text-strong-950">
                            {part.text
                              .replaceAll("{company}", selected.name)
                              .replaceAll("{name}", "您")
                              .replaceAll("{rep}", repName ?? "我")}
                          </p>
                          <p className="mt-1.5 text-paragraph-xs text-text-soft-400">{part.goal}</p>
                        </div>
                      ))}
                    </div>

                    <details className="rounded-lg bg-bg-weak-50 p-3">
                      <summary className="cursor-pointer text-label-sm text-text-strong-950">对方可能会问（{script.objections.length}）</summary>
                      <ul className="mt-2 space-y-1.5">
                        {script.objections.map((item) => (
                          <li key={item.question} className="text-paragraph-sm text-text-sub-600">
                            <span className="text-text-strong-950">{item.question}</span> → {item.answer}
                          </li>
                        ))}
                      </ul>
                    </details>

                    <details className="rounded-lg bg-bg-weak-50 p-3">
                      <summary className="cursor-pointer text-label-sm text-text-strong-950">这通电话必须拿到</summary>
                      <ul className="mt-2 space-y-1">
                        {script.mustGet.map((item) => (
                          <li key={item} className="text-paragraph-sm text-text-sub-600">□ {item}</li>
                        ))}
                      </ul>
                      <p className="mt-3 text-label-xs text-error-dark">不要说：</p>
                      <ul className="mt-1 space-y-1">
                        {script.avoid.map((item) => (
                          <li key={item} className="text-paragraph-xs text-text-sub-600">× {item}</li>
                        ))}
                      </ul>
                    </details>

                    <div>
                      <p className="mb-1.5 text-label-sm text-text-strong-950">打完记一句</p>
                      <textarea
                        value={callNotes[selected.key] ?? ""}
                        onChange={(event) => setCallNotes((prev) => ({ ...prev, [selected.key]: event.target.value }))}
                        rows={3}
                        placeholder="比如：说现在用另一家，嫌贵；约了周四寄样品"
                        className="w-full rounded-lg bg-bg-white-0 px-3 py-2 text-paragraph-sm text-text-strong-950 outline-none ring-1 ring-inset ring-stroke-soft-200 focus:ring-stroke-strong-950"
                      />
                      <p className="mt-1 text-paragraph-xs text-text-soft-400">
                        这一版记录只留在当前页面。要进 CRM 跟踪，先把公司加进线索库，再去记录页写跟进。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 系统对这个产品的判断：买家是谁、用什么词搜的、把握多大。 */
function IntentCard({ result }: { result: ProductSearchResponse }) {
  const { intent, perTerm } = result;
  return (
    <div className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-label-sm text-text-strong-950">
            「{intent.query}」{intent.category ? `→ ${intent.category}` : ""}
          </p>
          <p className="mt-1 text-paragraph-sm text-text-sub-600">买家：{intent.buyerDescription}</p>
        </div>
        <span className={cn(
          "shrink-0 rounded-md px-2 py-1 text-label-xs ring-1 ring-inset",
          intent.confidence >= 0.7
            ? "bg-success-lighter text-success-dark ring-success-light"
            : "bg-warning-lighter text-warning-dark ring-warning-light",
        )}>
          {intent.source === "dictionary" ? "词典命中" : `AI 推断 · 把握 ${Math.round(intent.confidence * 100)}%`}
        </span>
      </div>

      {intent.uncertainties.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {intent.uncertainties.map((item) => (
            <li key={item} className="text-paragraph-xs text-warning-dark">注：{item}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {perTerm.map((entry) => (
          <span
            key={entry.term}
            className={cn(
              "rounded-md px-2 py-0.5 text-paragraph-xs ring-1 ring-inset",
              entry.hits > 0
                ? "bg-bg-weak-50 text-text-sub-600 ring-stroke-soft-200"
                : "bg-bg-white-0 text-text-soft-400 ring-stroke-soft-200",
            )}
            title={entry.error}
          >
            {entry.term} · {entry.hits}
          </span>
        ))}
      </div>
    </div>
  );
}
