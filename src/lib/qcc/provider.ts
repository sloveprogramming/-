import "server-only";

import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { qccConfigured, searchQcc } from "./client";
import type { CompanyHit, SearchResult } from "./types";

/**
 * 「找客户」的搜索入口：配置了企查查就搜全国，没配置就搜自己库里已有的公司。
 *
 * 两条路的返回形状一样，所以界面只有一套；销售不需要知道背后接了谁。
 */

const LOCAL_LIMIT = 20;

/** 搜本地公司库。已经在本地的公司，inLibrary 恒为 true。 */
async function searchLocal(query: string): Promise<CompanyHit[]> {
  const term = `%${query.trim()}%`;
  if (!query.trim()) {
    // 空查询列出最近的 20 家，方便"看看我库里都有谁"。
    const rows = await db
      .select({ company: companies })
      .from(companies)
      .where(inOrg(companies))
      .orderBy(sql`${companies.createdAt} desc`)
      .limit(LOCAL_LIMIT);
    return rows.map(({ company }) => toHit(company));
  }
  const rows = await db
    .select({ company: companies })
    .from(companies)
    .where(and(inOrg(companies), or(ilike(companies.name, term), ilike(companies.domain, term))))
    .limit(LOCAL_LIMIT);
  return rows.map(({ company }) => toHit(company));
}

type CompanyRow = typeof companies.$inferSelect;

function toHit(company: CompanyRow): CompanyHit {
  const custom = (company.custom ?? {}) as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  return {
    key: company.id,
    name: company.name ?? company.domain,
    creditCode: text(custom.统一社会信用代码) ?? text(custom.creditCode),
    region: text(custom.地区) ?? text(custom.region),
    industry: text(custom.行业) ?? text(custom.industry),
    legalPerson: text(custom.法定代表人) ?? text(custom.legalPerson),
    foundedAt: text(custom.成立日期) ?? text(custom.foundedAt),
    registeredCapital: text(custom.注册资本) ?? text(custom.registeredCapital),
    phones: text(custom.电话) ? [text(custom.电话) as string] : [],
    scope: text(custom.经营范围) ?? text(custom.scope),
    status: text(custom.经营状态) ?? text(custom.status),
    inLibrary: true,
  };
}

/** 本地库里已有的公司名/信用代码，用来给企查查结果打「已在库」标记。 */
async function libraryKeys(): Promise<{ names: Set<string>; credits: Set<string> }> {
  const rows = await db
    .select({ name: companies.name, domain: companies.domain, custom: companies.custom })
    .from(companies)
    .where(inOrg(companies))
    .limit(5000);
  const names = new Set<string>();
  const credits = new Set<string>();
  for (const row of rows) {
    if (row.name) names.add(row.name);
    if (row.domain) names.add(row.domain);
    const custom = (row.custom ?? {}) as Record<string, unknown>;
    const credit = custom.统一社会信用代码 ?? custom.creditCode;
    if (typeof credit === "string" && credit.trim()) credits.add(credit.trim());
  }
  return { names, credits };
}

export async function searchCompanies(
  query: string,
  options: { source?: "auto" | "local" | "qcc"; limit?: number } = {},
): Promise<SearchResult> {
  const trimmed = query.trim();
  const source = options.source ?? "auto";

  if (source === "local" || (source === "auto" && !qccConfigured())) {
    const hits = await searchLocal(trimmed);
    return {
      source: "local",
      total: hits.length,
      hits,
      notice: qccConfigured() ? null : "当前只在本地线索库里搜索。接入企查查（QCC_APP_KEY / QCC_SECRET_KEY）后可以搜全国企业。",
    };
  }

  try {
    const hits = await searchQcc(trimmed, { limit: options.limit ?? LOCAL_LIMIT });
    const library = await libraryKeys();
    return {
      source: "qcc",
      total: hits.length,
      hits: hits.map((hit) => ({
        ...hit,
        inLibrary: library.names.has(hit.name) || (hit.creditCode ? library.credits.has(hit.creditCode) : false),
      })),
      notice: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 搜不到和没接通必须看起来不一样，所以这里带上错误，同时退回本地结果。
    const local = await searchLocal(trimmed);
    return {
      source: "local",
      total: local.length,
      hits: local,
      notice: `企查查调用失败，已退回本地结果：${message}`,
    };
  }
}

export type ImportResult = { created: number; existing: number; skipped: number };

/**
 * 把搜索结果加入线索库。
 *
 * 只建 `companies`，不硬造联系人——企业微信/电话时代，先有公司再找人更自然；
 * 凭空建一个"（待确认）"的人只会污染线索表。公司在 Leads 的「公司」页签里可见，
 * 之后补联系人时它会自动挂上去。
 */
export async function importCompanies(hits: readonly CompanyHit[]): Promise<ImportResult> {
  const result: ImportResult = { created: 0, existing: 0, skipped: 0 };
  if (!hits.length) return result;

  const names = hits.map((hit) => hit.name.trim()).filter(Boolean);
  const existing = await db
    .select({ name: companies.name, domain: companies.domain })
    .from(companies)
    .where(and(inOrg(companies), inArray(companies.name, names.length ? names : [""])));
  const known = new Set(existing.map((row) => row.name ?? row.domain));

  for (const hit of hits) {
    if (!hit.name.trim() || known.has(hit.name)) {
      result.skipped += 1;
      continue;
    }
    // domain 在这个库里是必填的唯一键（历史上公司靠域名去重）。企查查不给域名，
    // 用信用代码兜一个稳定的伪域名，既满足唯一约束又不跟真实域名混淆。
    const domain = hit.creditCode?.trim()
      ? `qcc-${hit.creditCode.trim().toLowerCase()}.local`
      : `qcc-${Buffer.from(hit.name).toString("base64url").slice(0, 24).toLowerCase()}.local`;
    await db
      .insert(companies)
      .values({
        organizationId: currentOrganizationId(),
        name: hit.name.trim(),
        domain,
        source: "qcc",
        custom: {
          统一社会信用代码: hit.creditCode,
          地区: hit.region,
          行业: hit.industry,
          法定代表人: hit.legalPerson,
          成立日期: hit.foundedAt,
          注册资本: hit.registeredCapital,
          电话: hit.phones[0] ?? null,
          经营范围: hit.scope,
          经营状态: hit.status,
        },
      })
      .onConflictDoNothing();
    known.add(hit.name);
    result.created += 1;
  }
  return result;
}

/** 线索库里的联系人数量，界面上用于提示"这家公司已经有人了"。 */
export async function peopleCountForCompanies(companyIds: string[]): Promise<Map<string, number>> {
  if (!companyIds.length) return new Map();
  const rows = await db
    .select({ companyId: people.companyId, count: sql<number>`count(*)::int` })
    .from(people)
    .where(and(inOrg(people), inArray(people.companyId, companyIds)))
    .groupBy(people.companyId);
  return new Map(rows.flatMap((row) => (row.companyId ? [[row.companyId, Number(row.count)] as const] : [])));
}
