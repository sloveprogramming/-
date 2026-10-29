import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { getOrCreateCrmRecordForCall } from "@/lib/crm/records";
import { withCrmTransaction } from "@/lib/crm/repository";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { CompanyHit } from "@/lib/qcc/types";

/**
 * 把拓客名单上的一家公司，变成一条**能跟踪的 CRM 记录**。
 *
 * 这是整条链上唯一断掉的一环：CRM 记录必须挂在一个人身上，而企查查只给
 * 公司、不给联系人姓名。所以这里补一个"临时联系人"——
 *
 *   fullName: "临安烘焙食品有限公司·前台"
 *   phone:    0571-88880001
 *   custom.待确认联系人: true
 *   source:   "prospect:public-phone"
 *
 * 为什么建"假人"是对的：公示电话真实存在，人确实要打，只是不知道对方叫谁。
 * 不建这个联系人，公司就进不了 CRM，阶段、跟进、拜访全都无从谈起——那是
 * 更大的失真。打完电话知道名字后，销售在记录页改名即可。
 *
 * 为什么标 `待确认联系人`: 让界面上能显示"这个联系人还没确认"，避免销售
 * 以为真的对接上了某个人。
 */

export type PromotionResult = {
  companyId: string;
  personId: string;
  recordId: string;
  /** 公司是不是这次新建的（已存在则复用）。 */
  companyCreated: boolean;
  personCreated: boolean;
  recordCreated: boolean;
};

/** 公司在这条库里的唯一键：优先信用代码，否则用名字。 */
function domainFor(hit: CompanyHit): string {
  const credit = hit.creditCode?.trim().toLowerCase();
  if (credit) return `qcc-${credit}.local`;
  // 与 importCompanies 保持一致的兜底策略：名字 → 稳定的伪域名。
  return `qcc-${Buffer.from(hit.name).toString("base64url").slice(0, 24).toLowerCase()}.local`;
}

/**
 * 把一家公司提升成 CRM 记录。幂等：重复调用复用已有的公司 / 联系人 / 记录。
 *
 * 只建一个联系人。如果这家公司已经有人（比如销售手动加过采购王总），
 * 就复用第一个，不硬塞一个"前台"进去——那会让记录里的人莫名其妙地变。
 */
export async function promoteCompanyToCrm(hit: CompanyHit): Promise<PromotionResult> {
  const organizationId = currentOrganizationId();
  const companyName = hit.name.trim();
  if (!companyName) throw new Error("公司名不能为空");

  // ---- 1. 公司：有就复用，没有就建 ----
  const domain = domainFor(hit);
  let companyId: string;
  let companyCreated = false;
  const [existingCompany] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(inOrg(companies), eq(companies.domain, domain)))
    .limit(1);
  if (existingCompany) {
    companyId = existingCompany.id;
    // 补齐可能缺失的工商字段（老数据可能只有名字）。
    await db
      .update(companies)
      .set({
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
      .where(and(inOrg(companies), eq(companies.id, companyId)));
  } else {
    const [created] = await db
      .insert(companies)
      .values({
        organizationId,
        name: companyName,
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
      .onConflictDoNothing()
      .returning({ id: companies.id });
    if (created) {
      companyId = created.id;
      companyCreated = true;
    } else {
      // 并发插入撞了唯一键：再查一次拿到 id。
      const [again] = await db
        .select({ id: companies.id })
        .from(companies)
        .where(and(inOrg(companies), eq(companies.domain, domain)))
        .limit(1);
      if (!again) throw new Error("公司已存在但读不出来，请重试");
      companyId = again.id;
    }
  }

  // ---- 2. 联系人：这家公司已经有人就复用，没有就建"临时联系人" ----
  const [existingPerson] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(inOrg(people), eq(people.companyId, companyId)))
    .orderBy(people.createdAt)
    .limit(1);

  let personId: string;
  let personCreated = false;
  if (existingPerson) {
    personId = existingPerson.id;
  } else {
    const [created] = await db
      .insert(people)
      .values({
        organizationId,
        companyId,
        // 用公司名 + 前台做称呼：销售一眼能看出这是"还没确认的人"。
        fullName: `${companyName}·前台`,
        // 电话写进 phone 字段：后面查重、外呼、展示都用这一个字段。
        phone: hit.phones[0] ?? null,
        source: "prospect:public-phone",
        custom: {
          待确认联系人: true,
          公司公示电话: hit.phones[0] ?? null,
        },
        raw: {},
      })
      .returning({ id: people.id });
    personId = created.id;
    personCreated = true;
  }

  // ---- 3. CRM 记录：走既有入口，它会自己处理"已存在就复用" ----
  //
  // 用 getOrCreateCrmRecordForCall 而不是 ForInbound：这条记录是"我们要主动
  // 联系他"，不是"他先回复了"。前者不需要会话，正好符合这个场景。
  const { record, created: recordCreated } = await withCrmTransaction((tx) =>
    getOrCreateCrmRecordForCall(tx, {
      personId,
      cause: "first_call",
      actorType: "authenticated_operator",
      actorRef: null,
    }),
  );

  return {
    companyId,
    personId,
    recordId: record.id,
    companyCreated,
    personCreated,
    recordCreated,
  };
}

/** 批量提升，逐个容错：一家失败不影响其余。 */
export async function promoteCompaniesToCrm(hits: readonly CompanyHit[]): Promise<{
  results: PromotionResult[];
  failed: Array<{ name: string; error: string }>;
}> {
  const results: PromotionResult[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const hit of hits) {
    try {
      results.push(await promoteCompanyToCrm(hit));
    } catch (error) {
      failed.push({ name: hit.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, failed };
}

/** 这批公司里有哪些已经在 CRM 里了——名单上用来标"已加入"。 */
export async function promotedCompanyIds(companyNames: readonly string[]): Promise<Set<string>> {
  if (!companyNames.length) return new Set();
  const rows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(and(
      inOrg(companies),
      inArray(companies.name, [...companyNames]),
      sql`exists (select 1 from people p where p.company_id = ${companies.id})`,
    ));
  return new Set(rows.flatMap((row) => (row.name ? [row.name] : [])));
}
