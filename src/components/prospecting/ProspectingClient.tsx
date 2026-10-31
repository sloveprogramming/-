"use client";

import { useCallback, useMemo, useState } from "react";
import { RiAddLine, RiLoader4Line, RiSearchLine, RiUserSearchLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import * as Input from "@/components/alignui/input";
import * as Table from "@/components/alignui/table";
import { EmptyState } from "@/components/page/EmptyState";
import { PageHeader } from "@/components/page/PageHeader";
import { Callout } from "@/components/settings/SettingsKit";
import { cn } from "@/utils/cn";
import type { CompanyHit, SearchResult } from "@/lib/qcc/types";

/**
 * 找客户：搜企业 → 看详情 → 加入线索库。
 *
 * 数据源由服务端决定（有企查查账号就搜全国，没有就搜自己库里已有的公司），
 * 界面上不做区分，只在顶部用一行说明当前在搜哪儿。
 */

const cell = "px-3 py-2.5 align-middle";

export function ProspectingClient({
  keywordGroups,
  qccEnabled,
}: {
  keywordGroups: { label: string; words: readonly string[] }[];
  qccEnabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<string | null>(null);

  const runSearch = useCallback(async (term: string) => {
    setSearching(true);
    setError(null);
    setImported(null);
    setSelected({});
    try {
      const response = await fetch(`/api/prospecting/search?q=${encodeURIComponent(term)}`);
      const data = (await response.json()) as SearchResult & { error?: string };
      if (!response.ok || data.error) {
        setError(data.error ?? "搜索失败");
        setResult(null);
        return;
      }
      setResult(data);
    } catch {
      setError("网络请求失败，请重试");
      setResult(null);
    } finally {
      setSearching(false);
    }
  }, []);

  const hits = useMemo(() => result?.hits ?? [], [result]);
  const selectedHits = useMemo(() => hits.filter((hit) => selected[hit.key]), [hits, selected]);
  const importable = selectedHits.filter((hit) => !hit.inLibrary);

  async function doImport() {
    if (!importable.length) return;
    setImporting(true);
    setError(null);
    try {
      const response = await fetch("/api/prospecting/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hits: importable }),
      });
      const data = (await response.json()) as { ok?: boolean; created?: number; skipped?: number; error?: string };
      if (!response.ok || data.error) {
        setError(data.error ?? "导入失败");
        return;
      }
      setImported(`已加入 ${data.created ?? 0} 家${data.skipped ? `，跳过 ${data.skipped} 家（已在库或重复）` : ""}`);
      setSelected({});
      // 重新搜一次，让「已在库」标记刷新。
      await runSearch(query);
    } catch {
      setError("网络请求失败，请重试");
    } finally {
      setImporting(false);
    }
  }

  const allSelected = hits.length > 0 && hits.every((hit) => selected[hit.key] || hit.inLibrary);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 sm:px-6">
      <PageHeader
        title="找客户"
        description="按行业、品类、地区搜企业，把合适的加进线索库，再打分、分配、跟进。"
      />

      <div className="rounded-xl bg-bg-white-0 p-4 ring-1 ring-inset ring-stroke-soft-200">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void runSearch(query);
          }}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <Input.Root size="medium" className="flex-1">
            <Input.Wrapper>
              <Input.Icon as={RiSearchLine} />
              <Input.Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="公司名、关键词，比如「坚果 经销商」「临安 炒货」"
                aria-label="搜索企业"
              />
            </Input.Wrapper>
          </Input.Root>
          <Button.Root type="submit" variant="primary" mode="filled" size="small" disabled={searching}>
            {searching ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiSearchLine} />}
            搜索
          </Button.Root>
        </form>

        <div className="mt-3 flex flex-col gap-2">
          {keywordGroups.map((group) => (
            <div key={group.label} className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-paragraph-xs text-text-soft-400">{group.label}</span>
              {group.words.map((word) => (
                <button
                  key={word}
                  type="button"
                  onClick={() => {
                    setQuery(word);
                    void runSearch(word);
                  }}
                  className="rounded-md px-2 py-0.5 text-paragraph-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 transition hover:bg-bg-weak-50"
                >
                  {word}
                </button>
              ))}
            </div>
          ))}
        </div>

        <p className="mt-3 text-paragraph-xs text-text-soft-400">
          {qccEnabled
            ? "已接入企查查：搜索的是全国企业。"
            : "当前只在本地线索库里搜索。在环境变量里配置 QCC_APP_KEY / QCC_SECRET_KEY 后，这里会改为搜全国企业。"}
        </p>
      </div>

      {error && <Callout tone="error" title="出错了">{error}</Callout>}
      {result?.notice && <Callout tone="info" title="提示">{result.notice}</Callout>}
      {imported && <Callout tone="success" title="导入完成">{imported}</Callout>}

      {result && (
        <div className="rounded-xl bg-bg-white-0 ring-1 ring-inset ring-stroke-soft-200">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-stroke-soft-200 px-4 py-3">
            <p className="text-label-sm text-text-strong-950">
              共 {result.total} 家 · {result.source === "qcc" ? "企查查" : "本地线索库"}
            </p>
            <div className="flex items-center gap-2">
              <Button.Root
                type="button"
                variant="neutral"
                mode="stroke"
                size="xsmall"
                onClick={() => {
                  if (allSelected) return setSelected({});
                  setSelected(Object.fromEntries(hits.map((hit) => [hit.key, true])));
                }}
              >
                {allSelected ? "取消全选" : "全选"}
              </Button.Root>
              <Button.Root
                type="button"
                variant="primary"
                mode="filled"
                size="xsmall"
                disabled={!importable.length || importing}
                onClick={() => void doImport()}
              >
                {importing ? <Button.Icon as={RiLoader4Line} className="animate-spin" /> : <Button.Icon as={RiAddLine} />}
                加入线索库{importable.length ? `（${importable.length}）` : ""}
              </Button.Root>
            </div>
          </div>

          {hits.length === 0 ? (
            <EmptyState
              icon={RiUserSearchLine}
              title="没有找到"
              description={qccEnabled ? "换个关键词试试，或者用上面的关键词标签。" : "本地库里没有匹配的公司。接入企查查后可以搜全国企业。"}
            />
          ) : (
            <Table.Root>
              <Table.Header>
                <tr>
                  <Table.Head className="w-10" />
                  <Table.Head>公司</Table.Head>
                  <Table.Head className="w-40">地区</Table.Head>
                  <Table.Head className="w-40">行业</Table.Head>
                  <Table.Head className="w-40">电话</Table.Head>
                  <Table.Head className="w-24">状态</Table.Head>
                </tr>
              </Table.Header>
              <Table.Body>
                {hits.map((hit) => (
                  <ProspectingRow
                    key={hit.key}
                    hit={hit}
                    checked={Boolean(selected[hit.key]) || hit.inLibrary}
                    onToggle={() => setSelected((prev) => ({ ...prev, [hit.key]: !prev[hit.key] }))}
                  />
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </div>
      )}
    </div>
  );
}

function ProspectingRow({ hit, checked, onToggle }: { hit: CompanyHit; checked: boolean; onToggle: () => void }) {
  return (
    <Table.Row className={cn(hit.inLibrary && "opacity-70")}>
      <Table.Cell className={cell}>
        <input
          type="checkbox"
          checked={checked}
          disabled={hit.inLibrary}
          onChange={onToggle}
          aria-label={`选择 ${hit.name}`}
          className="size-4 rounded border-stroke-soft-200"
        />
      </Table.Cell>
      <Table.Cell className={cell}>
        <div className="min-w-0">
          <p className="truncate text-label-sm text-text-strong-950" title={hit.name}>{hit.name}</p>
          <p className="truncate text-paragraph-xs text-text-soft-400">
            {[hit.legalPerson && `法人 ${hit.legalPerson}`, hit.registeredCapital, hit.foundedAt && `成立 ${hit.foundedAt}`]
              .filter(Boolean)
              .join(" · ") || "—"}
          </p>
        </div>
      </Table.Cell>
      <Table.Cell className={cn(cell, "text-paragraph-sm text-text-sub-600")}>{hit.region ?? "—"}</Table.Cell>
      <Table.Cell className={cn(cell, "text-paragraph-sm text-text-sub-600")}>{hit.industry ?? "—"}</Table.Cell>
      <Table.Cell className={cn(cell, "text-paragraph-sm text-text-sub-600")}>{hit.phones[0] ?? "—"}</Table.Cell>
      <Table.Cell className={cell}>
        {hit.inLibrary ? (
          <span className="rounded-md bg-bg-weak-50 px-2 py-0.5 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">已在库</span>
        ) : (
          <span className="text-paragraph-xs text-text-soft-400">{hit.status ?? "—"}</span>
        )}
      </Table.Cell>
    </Table.Row>
  );
}
