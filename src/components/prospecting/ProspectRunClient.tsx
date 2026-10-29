"use client";

import { useState } from "react";
import {
  RiAlertLine,
  RiArrowRightLine,
  RiCheckLine,
  RiFileCopyLine,
  RiLoader4Line,
  RiPhoneLine,
  RiRobot2Line,
  RiSearchLine,
} from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { Callout } from "@/components/settings/SettingsKit";
import { cn } from "@/utils/cn";
import { PROSPECT_STAGES, STAGE_LABEL, type ProspectStage } from "@/lib/agent/pipelineTypes";
import { TIER_LABEL, type CompanyAssessment } from "@/lib/icp/assess";
import { RiUserAddLine } from "@remixicon/react";
import type { ProductIntent } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * 产品拓客工作台：一次跑完四个 Agent，把结果摊开给人看。
 *
 * 界面组织的核心思路是**让每个 Agent 的产出都可见**：
 *
 *   1. 它把产品理解成了什么（品类、买家、搜索词）
 *   2. 它搜了哪些词、每个词搜到几家
 *   3. 每家公司的分数与分档（含"这一项是实测还是推断"）
 *   4. 哪家有电话、话术是什么
 *
 * 为什么不藏起来只给结果：这套流程的每一步都可能判断错（品类认错、搜错词、
 * 分数偏高）。把中间产物摊开，销售能一眼看出"哪里不对"，而不是盲信一个总分。
 */

type CompanyResult = CompanyAssessment & {
  hit: CompanyHit;
  phones: string[];
  reachable: boolean;
  scriptText: string | null;
};

type RunResponse = {
  ok: boolean;
  summary: string;
  product: string;
  intent: ProductIntent;
  stats: { searchedTerms: number; found: number; reachable: number; priority: number };
  companies: CompanyResult[];
  error?: string;
};

const STAGES = PROSPECT_STAGES;

export function ProspectRunClient({ qccEnabled }: { qccEnabled: boolean }) {
  const [product, setProduct] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCompany, setOpenCompany] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [promoted, setPromoted] = useState<Record<string, string>>({});
  const [promoting, setPromoting] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (!product.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setOpenCompany(null);
    try {
      const response = await fetch("/api/prospect/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product: product.trim() }),
      });
      const body = (await response.json()) as RunResponse;
      if (!response.ok || !body.ok) {
        setError(body.error ?? "执行失败");
        return;
      }
      setResult(body);
      // 默认展开第一家可打的公司——销售最想看的就是"我该先打谁、说什么"。
      const first = body.companies.find((company) => company.reachable);
      if (first) setOpenCompany(first.hit.key);
    } catch {
      setError("网络请求失败");
    } finally {
      setRunning(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // 浏览器拒绝时静默失败，用户仍可手动选中。
    }
  }

  /**
   * 把一家公司加进 CRM：建公司 + 临时联系人 + 记录，然后跳过去。
   *
   * 成功后直接跳转，不弹"操作成功"——销售要的是"我现在能开始跟这家了"，
   * 不是确认自己点对了。
   */
  async function promote(company: CompanyResult) {
    setPromoting(company.hit.key);
    setError(null);
    try {
      const response = await fetch("/api/prospect/promote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hits: [company.hit] }),
      });
      const body = (await response.json()) as {
        ok?: boolean;
        promoted?: Array<{ recordId: string }>;
        failed?: Array<{ name: string; error: string }>;
        error?: string;
      };
      if (!response.ok || !body.ok) {
        setError(body.error ?? "加入失败");
        return;
      }
      if (body.failed?.length) {
        setError(`${body.failed[0].name}：${body.failed[0].error}`);
        return;
      }
      const recordId = body.promoted?.[0]?.recordId;
      if (!recordId) {
        setError("加入成功但没有拿到记录 id");
        return;
      }
      setPromoted((prev) => ({ ...prev, [company.hit.key]: recordId }));
      // 直接进记录页——加进去的目的就是开始跟。
      window.location.href = `/crm/actions?record=${recordId}`;
    } catch {
      setError("网络请求失败");
    } finally {
      setPromoting(null);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader
        title="产品拓客"
        description="说一个产品，四个 Agent 依次干活：解析买家 → 搜公司 → 评估体量 → 备好电话话术。"
      />

      <div className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
        <form onSubmit={run} className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input.Root size="medium" className="flex-1">
            <Input.Wrapper>
              <Input.Icon as={RiSearchLine} />
              <Input.Input
                value={product}
                onChange={(event) => setProduct(event.target.value)}
                placeholder="比如「面包丝」「山核桃仁」「年货礼盒」"
                aria-label="产品名"
              />
            </Input.Wrapper>
          </Input.Root>
          <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={running || !product.trim()}>
            {running ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <RiArrowRightLine className="size-4" />}
            {running ? "正在跑…" : "开始拓客"}
          </Button.Root>
        </form>
        <p className="mt-3 text-paragraph-xs text-text-soft-400">
          {qccEnabled
            ? "已接入企查查：搜全国企业的工商信息与公示电话。"
            : "当前只在本地线索库里搜。配置 QCC_APP_KEY 后可搜全国企业。"}
        </p>
      </div>

      {error && <Callout tone="error" title="执行失败">{error}</Callout>}

      {(running || result) && (
        <StageStrip running={running} done={Boolean(result)} stats={result?.stats} />
      )}

      {result && (
        <>
          {result.companies.length === 0 ? (
            <EmptyState
              icon={RiSearchLine}
              title="没有搜到公司"
              description={`「${result.product}」按 ${result.stats.searchedTerms} 个关键词都没搜到结果。换个更通用的品类词试试。`}
            />
          ) : (
            <>
              <IntentPanel result={result} />
              <div className="flex flex-col gap-2">
                <p className="text-label-sm text-text-strong-950">
                  评估结果（{result.companies.length} 家，按可打性与体量排序）
                </p>
                {result.companies.map((company) => (
                  <CompanyRow
                    key={company.hit.key}
                    company={company}
                    open={openCompany === company.hit.key}
                    copied={copied}
                    promoted={Boolean(promoted[company.hit.key])}
                    promoting={promoting === company.hit.key}
                    onToggle={() => setOpenCompany((prev) => (prev === company.hit.key ? null : company.hit.key))}
                    onCopy={copy}
                    onPromote={() => void promote(company)}
                  />
                ))}
              </div>
              <Callout tone="warning" title="关于分数">
                分数由公开工商数据推断：注册资本（认缴）、成立年限、行业匹配、经营状态。
                **不含参保人数与实缴出资**——这两项需要企查查付费详情接口，拿不到就没有。
                分数高只说明"看起来对得上"，不代表对方有真实采购需求。
              </Callout>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** 四段流水线的视觉：跑的时候亮，跑完打勾。 */
function StageStrip({ running, done, stats }: { running: boolean; done: boolean; stats?: RunResponse["stats"] }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-bg-white-0 px-4 py-3 ring-1 ring-inset ring-stroke-soft-200">
      {STAGES.map((stage, index) => {
        const active = running && index === (stats ? STAGES.length : 0);
        return (
          <span key={stage} className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-paragraph-xs ring-1 ring-inset",
                done
                  ? "bg-success-lighter text-success-dark ring-success-light"
                  : active
                    ? "bg-information-lighter text-information-dark ring-information-light"
                    : "bg-bg-weak-50 text-text-soft-400 ring-stroke-soft-200",
              )}
            >
              {done
                ? <RiCheckLine className="size-3.5" />
                : running
                  ? <RiLoader4Line className="size-3.5 animate-spin" />
                  : <RiRobot2Line className="size-3.5" />}
              {STAGE_LABEL[stage]}
            </span>
            {index < STAGES.length - 1 && <RiArrowRightLine className="size-3.5 text-text-soft-400" />}
          </span>
        );
      })}
      {done && stats && (
        <span className="ml-auto text-paragraph-xs text-text-sub-600">
          {stats.searchedTerms} 个词 · {stats.found} 家 · {stats.reachable} 家可打 · {stats.priority} 家优先
        </span>
      )}
    </div>
  );
}

/** Agent 对产品的理解：品类、买家、搜索词。 */
function IntentPanel({ result }: { result: RunResponse }) {
  const { intent } = result;
  return (
    <div className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-label-sm text-text-strong-950">
            「{intent.query}」{intent.category ? ` → ${intent.category}` : ""}
          </p>
          <p className="mt-1 text-paragraph-sm text-text-sub-600">买家：{intent.buyerDescription}</p>
        </div>
        <span className={cn(
          "shrink-0 rounded-md px-2 py-1 text-label-xs ring-1 ring-inset",
          intent.confidence >= 0.7
            ? "bg-success-lighter text-success-dark ring-success-light"
            : "bg-warning-lighter text-warning-dark ring-warning-light",
        )}>
          {intent.source === "dictionary" ? "词典命中" : `AI 推断 · ${Math.round(intent.confidence * 100)}%`}
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
        {intent.searchTerms.map((term) => (
          <span key={term} className="rounded-md bg-bg-weak-50 px-2 py-0.5 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
            {term}
          </span>
        ))}
      </div>
    </div>
  );
}

function CompanyRow({
  company,
  open,
  copied,
  promoted,
  promoting,
  onToggle,
  onCopy,
  onPromote,
}: {
  company: CompanyResult;
  open: boolean;
  copied: string | null;
  promoted: boolean;
  promoting: boolean;
  onToggle: () => void;
  onCopy: (text: string, key: string) => void;
  onPromote: () => void;
}) {
  const tierTone = company.tier === "priority"
    ? "bg-success-lighter text-success-dark ring-success-light"
    : company.tier === "workable"
      ? "bg-warning-lighter text-warning-dark ring-warning-light"
      : "bg-bg-weak-50 text-text-soft-400 ring-stroke-soft-200";

  return (
    <div className="rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
      <button type="button" onClick={onToggle} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left">
        <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-label-xs ring-1 ring-inset", tierTone)}>
          {TIER_LABEL[company.tier]}
        </span>
        <span className="min-w-0 flex-1 truncate text-label-sm text-text-strong-950">{company.hit.name}</span>
        <span className="shrink-0 text-label-sm text-text-strong-950">{company.score}<span className="text-text-soft-400">/100</span></span>
        {company.reachable ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-paragraph-xs text-text-strong-950">
            <RiPhoneLine className="size-3.5" />
            {company.phones[0]}
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-paragraph-xs text-text-soft-400">
            <RiAlertLine className="size-3.5" />
            无电话
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-stroke-soft-200 px-4 py-3">
          <p className="text-paragraph-sm text-text-sub-600">{company.verdict}</p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {company.dimensions.map((dimension) => (
              <div key={dimension.key} className="rounded-lg bg-bg-weak-50 p-2.5">
                <p className="flex items-baseline justify-between gap-2">
                  <span className="text-label-xs text-text-strong-950">{dimension.label}</span>
                  <span className="text-paragraph-xs text-text-sub-600">
                    {dimension.score}/{dimension.max}
                  </span>
                </p>
                <p className="mt-1 text-paragraph-xs text-text-soft-400">{dimension.basis}</p>
                <span className={cn(
                  "mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset",
                  dimension.nature === "measured"
                    ? "bg-success-lighter text-success-dark ring-success-light"
                    : dimension.nature === "inferred"
                      ? "bg-warning-lighter text-warning-dark ring-warning-light"
                      : "bg-bg-white-0 text-text-soft-400 ring-stroke-soft-200",
                )}>
                  {dimension.nature === "measured" ? "实测" : dimension.nature === "inferred" ? "推断" : "未知"}
                </span>
              </div>
            ))}
          </div>

          {company.scriptText ? (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-label-sm text-text-strong-950">电话话术</p>
                <div className="flex gap-2">
                  <Button.Root
                    variant="neutral"
                    mode="stroke"
                    size="xsmall"
                    onClick={() => company.scriptText && void onCopy(company.scriptText, company.hit.key)}
                  >
                    <Button.Icon as={RiFileCopyLine} />
                    {copied === company.hit.key ? "已复制" : "复制"}
                  </Button.Root>
                  <Button.Root asChild variant="neutral" mode="stroke" size="xsmall">
                    <a href={`tel:${company.phones[0]}`}>
                      <RiPhoneLine className="size-4" />
                      拨号
                    </a>
                  </Button.Root>
                  <Button.Root
                    variant="primary"
                    mode="filled"
                    size="xsmall"
                    disabled={promoting || promoted}
                    onClick={onPromote}
                  >
                    {promoting
                      ? <Button.Icon as={RiLoader4Line} className="animate-spin" />
                      : <RiUserAddLine className="size-4" />}
                    {promoted ? "已加入" : promoting ? "加入中…" : "加入 CRM"}
                  </Button.Root>
                </div>
              </div>
              <pre className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg bg-bg-weak-50 p-3 text-paragraph-xs text-text-sub-600">
                {company.scriptText}
              </pre>
            </div>
          ) : (
            <p className="mt-3 rounded-lg bg-warning-lighter p-3 text-paragraph-xs text-warning-dark">
              这家没有公示电话。可以先加进线索库，用企微或邮件联系。
            </p>
          )}

          <details className="mt-3">
            <summary className="cursor-pointer text-paragraph-xs text-text-soft-400">工商信息与评估说明</summary>
            <dl className="mt-2 grid gap-1 text-paragraph-xs text-text-sub-600 sm:grid-cols-2">
              <div>注册资本：{company.hit.registeredCapital ?? "未公开"}</div>
              <div>成立日期：{company.hit.foundedAt ?? "未公开"}</div>
              <div>行业：{company.hit.industry ?? "未公开"}</div>
              <div>状态：{company.hit.status ?? "未公开"}</div>
              <div className="sm:col-span-2">经营范围：{company.hit.scope ?? "未公开"}</div>
            </dl>
            <ul className="mt-2 space-y-0.5">
              {company.caveats.map((caveat) => (
                <li key={caveat} className="text-paragraph-xs text-text-soft-400">· {caveat}</li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </div>
  );
}
