import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { crmConversationMessages, crmConversations, crmEvents, crmRecords } from "@/lib/crm/schema";
import { crmKnowledgeDocuments, crmKnowledgeDocumentVersions } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import type { ToolRegistry } from "../tools";

/**
 * Agent 的只读工具集：让它在起草之前能自己去查资料。
 *
 * 改造前，它能看到的只有调用方塞给它的上下文；现在它可以主动去拿：
 *
 *   lookup_customer     这个客户是谁、什么规模、在卖什么
 *   lookup_history      我们和这个人聊过什么（按渠道过滤）
 *   search_knowledge    知识库里有没有相关口径（产品、政策、案例）
 *   lookup_timeline     这个客户发生过哪些结构性事件（阶段变化、成交、退订）
 *
 * 全部是 `read` 风险：不改数据，可以放心让模型自己决定查几次。
 *
 * 每个工具都只返回**结构化数据**，不写自然语言解释——解释留给提示层，
 * 否则工具里的措辞会悄悄影响模型的判断。
 */

const MAX_ROWS = 20;

export function registerCustomerTools(registry: ToolRegistry): ToolRegistry {
  return registry
    .register({
      name: "lookup_customer",
      description:
        "查这个客户的档案：公司名、行业、地区、规模、经营范围、联系人职位。起草前先用它确认对象是谁。",
      risk: "read",
      schema: z.object({
        personId: z.string().describe("联系人 ID；不确定时留空，用当前会话的人"),
      }),
      execute: async ({ personId }, context) => {
        const id = personId?.trim() || (context.subject.type === "person" ? context.subject.id : null) || null;
        if (!id) return { error: "没有可查的联系人 ID" };
        const [row] = await db
          .select({ person: people, company: companies })
          .from(people)
          .leftJoin(companies, eq(companies.id, people.companyId))
          .where(and(inOrg(people), eq(people.id, id)))
          .limit(1);
        if (!row) return { error: "找不到这个联系人" };
        const custom = (row.company?.custom ?? {}) as Record<string, unknown>;
        return {
          person: {
            name: row.person.fullName,
            title: row.person.title,
            email: row.person.email,
            phone: row.person.phone,
            source: row.person.source,
          },
          company: row.company
            ? {
                name: row.company.name,
                domain: row.company.domain,
                industry: custom.行业 ?? custom.industry ?? null,
                region: custom.地区 ?? custom.region ?? null,
                scale: custom.规模 ?? custom.scale ?? null,
                scope: custom.经营范围 ?? custom.scope ?? null,
              }
            : null,
        };
      },
    })
    .register({
      name: "lookup_history",
      description:
        "查我们和这个客户的历史往来（最近若干条消息）。判断「上次说了什么」「是不是重复打扰」时用。",
      risk: "read",
      schema: z.object({
        personId: z.string().describe("联系人 ID；留空则用当前会话的人"),
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe("返回条数，默认 10"),
      }),
      execute: async ({ personId, limit }, context) => {
        const id = personId?.trim() || (context.subject.type === "person" ? context.subject.id : null) || null;
        if (!id) return { error: "没有可查的联系人 ID" };
        const rows = await db
          .select({
            channel: crmConversationMessages.channel,
            direction: crmConversationMessages.direction,
            sentAt: crmConversationMessages.sentAt,
            subject: crmConversationMessages.subject,
            bodyText: crmConversationMessages.bodyText,
          })
          .from(crmConversationMessages)
          .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
          .innerJoin(crmRecords, eq(crmRecords.id, crmConversations.crmRecordId))
          .where(and(inOrg(crmConversations), eq(crmRecords.personId, id)))
          .orderBy(desc(crmConversationMessages.sentAt))
          .limit(limit ?? 10);
        return {
          count: rows.length,
          messages: rows.map((row) => ({
            channel: row.channel,
            direction: row.direction,
            at: row.sentAt?.toISOString() ?? null,
            subject: row.subject,
            // 单条正文截断到 600 字：一整封报价邮件会把上下文撑爆。
            body: (row.bodyText ?? "").slice(0, 600),
          })),
        };
      },
    })
    .register({
      name: "search_knowledge",
      description:
        "在知识库里按关键词找口径：产品信息、合作政策、价格规则、常见异议。需要事实依据时用它，不要凭印象编。",
      risk: "read",
      schema: z.object({
        query: z.string().min(1).describe("关键词，例如「区域代理」「山核桃」「价格」"),
        limit: z.number().int().min(1).max(10).optional().describe("返回篇数，默认 3"),
      }),
      execute: async ({ query, limit }) => {
        const term = `%${query.trim()}%`;
        const rows = await db
          .select({
            title: crmKnowledgeDocuments.title,
            kind: crmKnowledgeDocuments.kind,
            content: crmKnowledgeDocumentVersions.content,
          })
          .from(crmKnowledgeDocuments)
          .innerJoin(
            crmKnowledgeDocumentVersions,
            and(
              eq(crmKnowledgeDocumentVersions.documentId, crmKnowledgeDocuments.id),
              eq(crmKnowledgeDocumentVersions.version, crmKnowledgeDocuments.latestVersion),
            ),
          )
          .where(and(
            inOrg(crmKnowledgeDocuments),
            eq(crmKnowledgeDocuments.active, true),
            sql`(${crmKnowledgeDocuments.title} ilike ${term} OR ${crmKnowledgeDocumentVersions.content} ilike ${term})`,
          ))
          .limit(limit ?? 3);
        return {
          count: rows.length,
          documents: rows.map((row) => ({
            title: row.title,
            kind: row.kind,
            // 只给命中段落附近的片段，不把整篇塞进去。
            excerpt: excerptAround(row.content, query, 500),
          })),
        };
      },
    })
    .register({
      name: "lookup_timeline",
      description:
        "查这个客户的结构性事件：分类变化、阶段推进、成交、退订。判断「为什么现在是这个阶段」时用。",
      risk: "read",
      schema: z.object({
        personId: z.string().describe("联系人 ID；留空则用当前会话的人"),
        limit: z.number().int().min(1).max(MAX_ROWS).optional(),
      }),
      execute: async ({ personId, limit }, context) => {
        const id = personId?.trim() || (context.subject.type === "person" ? context.subject.id : null) || null;
        if (!id) return { error: "没有可查的联系人 ID" };
        const rows = await db
          .select({
            eventType: crmEvents.eventType,
            actorType: crmEvents.actorType,
            createdAt: crmEvents.createdAt,
            toData: crmEvents.toData,
          })
          .from(crmEvents)
          .innerJoin(crmRecords, eq(crmRecords.id, crmEvents.crmRecordId))
          .where(and(inOrg(crmEvents), eq(crmRecords.personId, id)))
          .orderBy(desc(crmEvents.createdAt))
          .limit(limit ?? 10);
        return {
          count: rows.length,
          events: rows.map((row) => ({
            type: row.eventType,
            actor: row.actorType,
            at: row.createdAt.toISOString(),
            detail: row.toData,
          })),
        };
      },
    });
}

/** 取命中位置前后的一段文字，避免把整篇知识文档塞给模型。 */
export function excerptAround(text: string, query: string, span: number): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return text.slice(0, span);
  const start = Math.max(0, index - Math.floor(span / 3));
  const clipped = text.slice(start, start + span);
  return `${start > 0 ? "…" : ""}${clipped}${start + span < text.length ? "…" : ""}`;
}
