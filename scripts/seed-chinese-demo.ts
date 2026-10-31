/**
 * 中文演示数据：把整条拓客链路填满，让系统"看起来在真的运转"。
 *
 * 现有的 `scripts/db/seed-demo.ts` 会创建一个全新的 Northwind 组织（英文数据），
 * 不适合这个已经跑起来的实例。这个脚本**只填充已有组织**，并且是幂等的：
 * 已存在的按名称跳过，不会重复堆垃圾。
 *
 *   bun --conditions=react-server scripts/seed-chinese-demo.ts
 *
 * 造的场景是一整条链，每一环都能在界面上点到：
 *
 *   找客户   8 家坚果行业公司（含工商字段与公示电话）
 *   入库     联系人 + CRM 记录，分布在不同阶段
 *   触达     会话与消息往返（我们发的首触、客户回的答复）
 *   AI 分类  分类记录（有意向/已有供应商/暂时不需要/索取报价）
 *   AI 草稿  待审草稿（销售能看到 AI 写了什么）
 *   通话     通话记录（接通/未接通/转对接人 + 意向）
 *   拜访     拜访安排与完成纪要
 *   观测     几条 agent_runs（展示"这次跑了什么、花了多少"）
 *
 * 时间全部相对"现在"，因为 demo 里看"三天前""下周三"才有意义。
 */

import { sql } from "drizzle-orm";

type Ctx = {
  orgId: string;
  pipelineId: string;
  now: Date;
};

const DAY = 86_400_000;

function daysAgo(now: Date, days: number, hour = 10): Date {
  const date = new Date(now.getTime() - days * DAY);
  date.setHours(hour, 0, 0, 0);
  return date;
}

/** 8 家公司，覆盖不同行业、地区、体量——让名单和评分有层次。 */
const COMPANIES = [
  {
    name: "杭州临安松鼠坚果食品有限公司",
    creditCode: "91330185MA27XK8N2P",
    region: "浙江省 杭州市",
    industry: "休闲食品",
    legalPerson: "陈志明",
    foundedAt: "2012-03-15",
    registeredCapital: "2000万元人民币",
    phone: "0571-6388 8801",
    scope: "坚果炒货加工、预包装食品销售、食品批发",
    status: "存续",
    contacts: [
      { name: "陈志明", title: "总经理", phone: "138 0571 8801" },
      { name: "李娜", title: "采购经理", phone: "139 0571 8802" },
    ],
  },
  {
    name: "宁波甬南食品贸易有限公司",
    creditCode: "91330203MA2AF7XQ3R",
    region: "浙江省 宁波市",
    industry: "食品批发",
    legalPerson: "周建国",
    foundedAt: "2009-08-20",
    registeredCapital: "1200万元人民币",
    phone: "0574-8722 6601",
    scope: "预包装食品批发、日用百货销售、供应链管理",
    status: "存续",
    contacts: [{ name: "周建国", title: "老板", phone: "137 0574 6601" }],
  },
  {
    name: "苏州优鲜零食连锁有限公司",
    creditCode: "91320505MA1MTQ8L4K",
    region: "江苏省 苏州市",
    industry: "零食连锁",
    legalPerson: "吴晓峰",
    foundedAt: "2016-11-08",
    registeredCapital: "5000万元人民币",
    phone: "0512-6688 9902",
    scope: "食品销售、连锁门店经营、预包装食品零售",
    status: "存续",
    contacts: [{ name: "吴晓峰", title: "采购总监", phone: "136 0512 9902" }],
  },
  {
    name: "上海禾丰电子商务有限公司",
    creditCode: "91310115MA1K3YQN7T",
    region: "上海市 浦东新区",
    industry: "电商分销",
    legalPerson: "孙丽",
    foundedAt: "2018-05-30",
    registeredCapital: "500万元人民币",
    phone: "021-6068 7703",
    scope: "电子商务、食品互联网销售、仓储服务",
    status: "存续",
    contacts: [{ name: "孙丽", title: "运营负责人", phone: "135 0210 7703" }],
  },
  {
    name: "合肥徽州记食品有限公司",
    creditCode: "91340104MA2RT8XK9B",
    region: "安徽省 合肥市",
    industry: "食品加工",
    legalPerson: "胡国平",
    foundedAt: "2006-07-12",
    registeredCapital: "3000万元人民币",
    phone: "0551-6588 4404",
    scope: "炒货食品加工、坚果制品生产、食品销售",
    status: "存续",
    contacts: [{ name: "胡国平", title: "厂长", phone: "133 0551 4404" }],
  },
  {
    name: "成都锦官城礼品有限公司",
    creditCode: "91510107MA6CQ2LZ8M",
    region: "四川省 成都市",
    industry: "礼品团购",
    legalPerson: "杨帆",
    foundedAt: "2015-02-26",
    registeredCapital: "800万元人民币",
    phone: "028-8666 5505",
    scope: "礼品设计、企业福利礼品、会议会展服务",
    status: "存续",
    contacts: [{ name: "杨帆", title: "销售经理", phone: "132 0288 5505" }],
  },
  {
    name: "广州南粤供应链管理有限公司",
    creditCode: "91440106MA9UYXK72C",
    region: "广东省 广州市",
    industry: "餐饮供应链",
    legalPerson: "梁伟强",
    foundedAt: "2020-09-14",
    registeredCapital: "100万元人民币",
    phone: "020-3888 6606",
    scope: "供应链管理、食品配送、餐饮管理服务",
    status: "存续",
    contacts: [{ name: "梁伟强", title: "负责人", phone: "131 0208 6606" }],
  },
  {
    name: "青岛海韵食品进出口有限公司",
    creditCode: "91370212MA3MX8NQ5D",
    region: "山东省 青岛市",
    industry: "食品进出口",
    legalPerson: "王海涛",
    foundedAt: "2004-04-18",
    registeredCapital: "8000万元人民币",
    phone: "0532-8577 2207",
    scope: "食品进出口、干货批发、预包装食品销售",
    status: "注销",
    contacts: [{ name: "王海涛", title: "原法人", phone: "130 0532 2207" }],
  },
] as const;

/**
 * 每家公司的业务状态：决定它处于漏斗哪一环、有哪些消息和事件。
 *
 * 这正是"让项目更直观"的关键——不是堆八家公司，而是让八家都停在
 * **不同的、有意义的位置**，一看就懂流程走到哪了。
 */
type Scenario =
  | "needs_reply"      // 客户刚回，AI 草稿待审（销售该动手了）
  | "quoted"           // 已报过价，等答复
  | "meeting_planned"  // 约好拜访，还没去
  | "visited"          // 拜访完了，写了纪要
  | "rejected"         // 已有供应商，礼貌拒绝
  | "lost"             // 注销，不该打
  | "no_contact"       // 有电话没打通
  | "new_lead";        // 刚入库，还没触达

const SCENARIOS: Record<string, { scenario: Scenario; stageKey: string | null; days: number }> = {
  "杭州临安松鼠坚果食品有限公司": { scenario: "needs_reply", stageKey: "information_requested", days: 1 },
  "宁波甬南食品贸易有限公司": { scenario: "quoted", stageKey: "quote_requested", days: 4 },
  "苏州优鲜零食连锁有限公司": { scenario: "meeting_planned", stageKey: "meeting_requested", days: 6 },
  "上海禾丰电子商务有限公司": { scenario: "new_lead", stageKey: null, days: 9 },
  "合肥徽州记食品有限公司": { scenario: "visited", stageKey: "meeting_done", days: 12 },
  "成都锦官城礼品有限公司": { scenario: "no_contact", stageKey: "information_requested", days: 15 },
  "广州南粤供应链管理有限公司": { scenario: "rejected", stageKey: "already_using_a_tool_not_required", days: 20 },
  "青岛海韵食品进出口有限公司": { scenario: "lost", stageKey: "not_required_right_now", days: 45 },
};

/** 会话内容：每家一段真实感的中文往返回合。 */
const CONVERSATIONS: Record<string, Array<{ direction: "outbound" | "inbound"; subject: string; body: string; dayOffset: number }>> = {
  "杭州临安松鼠坚果食品有限公司": [
    {
      direction: "outbound",
      subject: "新农哥 · 坚果原料与成品供货合作",
      body: "陈总您好，\n\n我是新农哥的销售，我们在杭州临安做坚果炒货，山核桃、每日坚果、风味坚果都是自有产线。\n\n看到贵司在做坚果炒货加工和预包装食品批发，想跟您确认一下：现在山核桃仁这条线是从哪家进的货？\n\n我们最近有一批临安产地的山核桃仁，可以做区域独家也可以一件代发。方便的话我发一份产品目录给您。\n\n新农哥 · 销售",
      dayOffset: 3,
    },
    {
      direction: "inbound",
      subject: "Re: 新农哥 · 坚果原料与成品供货合作",
      body: "你好，\n\n我们目前山核桃是从本地一家合作社拿的，量不大。\n\n想先了解一下你们的规格和起订量，还有能不能做 OEM？我们的包装是自己设计的。\n\n另外如果有产品手册和检测报告，麻烦发一份过来。\n\n陈志明",
      dayOffset: 1,
    },
  ],
  "宁波甬南食品贸易有限公司": [
    {
      direction: "outbound",
      subject: "新农哥 · 每日坚果供货报价",
      body: "周总您好，\n\n上次电话里提到的每日坚果系列，按您说的每月 20 箱的量，我这边整理了一版报价。\n\n规格和价格见附件。首批可以给到搭赠支持。\n\n新农哥 · 销售",
      dayOffset: 5,
    },
    {
      direction: "inbound",
      subject: "Re: 新农哥 · 每日坚果供货报价",
      body: "收到，价格我看过了，比我们现在的高一点点。\n\n你们能不能按我们这个价做？另外账期一般怎么谈？\n\n我先跟老板报一下，这周给你答复。",
      dayOffset: 4,
    },
  ],
  "苏州优鲜零食连锁有限公司": [
    {
      direction: "outbound",
      subject: "新农哥 · 零食连锁渠道合作",
      body: "吴总您好，\n\n我们是新农哥，做坚果炒货的。看到优鲜在苏州有三十多家门店，想聊一下进店的事。\n\n我们有适合连锁的小包装规格，也有做过便利系统的经验。\n\n新农哥 · 销售",
      dayOffset: 8,
    },
    {
      direction: "inbound",
      subject: "Re: 新农哥 · 零食连锁渠道合作",
      body: "可以聊。我们下周三在苏州总部，你方便过来一趟吗？\n\n带上样品和小包装的规格表。",
      dayOffset: 6,
    },
  ],
  "合肥徽州记食品有限公司": [
    {
      direction: "outbound",
      subject: "新农哥 · 炒货原料供货",
      body: "胡厂长您好，\n\n了解到贵司做炒货加工，我们在临安有产地资源，想聊一下原料供应。",
      dayOffset: 18,
    },
    {
      direction: "inbound",
      subject: "Re: 新农哥 · 炒货原料供货",
      body: "我们下周二上午在厂里，你过来看看产线，顺便谈一下今年的量。",
      dayOffset: 15,
    },
  ],
  "成都锦官城礼品有限公司": [
    {
      direction: "outbound",
      subject: "新农哥 · 年货礼盒企业团购",
      body: "杨经理您好，\n\n我们在做坚果礼盒，适合企业年货和员工福利。想了解一下贵司今年的礼品采购计划。",
      dayOffset: 22,
    },
    {
      direction: "inbound",
      subject: "Re: 新农哥 · 年货礼盒企业团购",
      body: "先发一份礼盒目录和报价区间给我看看，我们这边在比几家。",
      dayOffset: 20,
    },
  ],
  "广州南粤供应链管理有限公司": [
    {
      direction: "outbound",
      subject: "新农哥 · 餐饮供应链供货",
      body: "梁总您好，\n\n看到贵司做餐饮供应链配送，想问一下坚果类原料这块有没有需求。",
      dayOffset: 25,
    },
    {
      direction: "inbound",
      subject: "Re: 新农哥 · 餐饮供应链供货",
      body: "不好意思，我们现在已经有固定供应商了，暂时不需要换。\n\n以后有需要再联系。",
      dayOffset: 20,
    },
  ],
};

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 没设置，检查 .env.local");
  const url = process.env.DATABASE_URL;
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    if (!process.argv.includes("--allow-remote")) {
      console.error("拒绝写入非本地数据库。确实要写请加 --allow-remote。");
      process.exit(1);
    }
  }

  const { db } = await import("@/lib/db");
  const { organizations } = await import("@/lib/auth/schema");
  const { companies, people } = await import("@/lib/leads/schema");
  const {
    crmPipelines, crmSubcategories, crmRecords, crmConversations, crmConversationMessages,
    crmClassifications, crmDrafts, crmEvents,
  } = await import("@/lib/crm/schema");
  const { agentRuns } = await import("@/lib/agent/schema");

  // ---- 定位组织与 pipeline ----
  const [org] = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).limit(1);
  if (!org) throw new Error("数据库里没有组织，先跑 db:setup");
  const [pipeline] = await db
    .select({ id: crmPipelines.id })
    .from(crmPipelines)
    .where(sql`${crmPipelines.organizationId} = ${org.id}`)
    .limit(1);
  if (!pipeline) throw new Error("没有 CRM 漏斗，先跑 scripts/seed-crm-response-taxonomy.ts");

  const ctx: Ctx = { orgId: org.id, pipelineId: pipeline.id, now: new Date() };
  console.log(`组织：${org.name}（${org.id}）`);
  console.log(`漏斗：${pipeline.id}`);

  const stages = await db
    .select({ id: crmSubcategories.id, key: crmSubcategories.key, categoryKey: crmSubcategories.categoryKey })
    .from(crmSubcategories)
    .where(sql`${crmSubcategories.pipelineId} = ${pipeline.id}`);
  const stageByKey = new Map(stages.map((stage) => [stage.key, stage]));

  const stats = { companies: 0, people: 0, records: 0, conversations: 0, messages: 0, classifications: 0, drafts: 0, events: 0, runs: 0, visits: 0 };

  for (const company of COMPANIES) {
    const scenario = SCENARIOS[company.name];
    if (!scenario) continue;
    const domain = `qcc-${company.creditCode.toLowerCase()}.local`;

    // ---- 公司（幂等：按 domain 判断）----
    const [existingCompany] = await db
      .select({ id: companies.id })
      .from(companies)
      .where(sql`${companies.organizationId} = ${org.id} and ${companies.domain} = ${domain}`)
      .limit(1);
    let companyId: string;
    if (existingCompany) {
      companyId = existingCompany.id;
    } else {
      const [created] = await db.insert(companies).values({
        organizationId: org.id,
        name: company.name,
        domain,
        source: "qcc",
        custom: {
          统一社会信用代码: company.creditCode,
          地区: company.region,
          行业: company.industry,
          法定代表人: company.legalPerson,
          成立日期: company.foundedAt,
          注册资本: company.registeredCapital,
          电话: company.phone,
          经营范围: company.scope,
          经营状态: company.status,
        },
      }).returning({ id: companies.id });
      companyId = created.id;
      stats.companies += 1;
    }

    // ---- 联系人 ----
    const personIds: Array<{ id: string; name: string; title: string }> = [];
    for (const contact of company.contacts) {
      const [existing] = await db
        .select({ id: people.id })
        .from(people)
        .where(sql`${people.organizationId} = ${org.id} and ${people.companyId} = ${companyId} and ${people.fullName} = ${contact.name}`)
        .limit(1);
      if (existing) {
        personIds.push({ id: existing.id, name: contact.name, title: contact.title });
        continue;
      }
      const [created] = await db.insert(people).values({
        organizationId: org.id,
        companyId,
        fullName: contact.name,
        firstName: contact.name.slice(0, 1),
        lastName: contact.name.slice(1),
        title: contact.title,
        phone: contact.phone,
        source: "qcc",
        custom: { 职位: contact.title, 手机: contact.phone },
        raw: {},
      }).returning({ id: people.id });
      personIds.push({ id: created.id, name: contact.name, title: contact.title });
      stats.people += 1;
    }
    if (!personIds.length) continue;
    const primary = personIds[0];

    // ---- CRM 记录 ----
    const [existingRecord] = await db
      .select({ id: crmRecords.id })
      .from(crmRecords)
      .where(sql`${crmRecords.organizationId} = ${org.id} and ${crmRecords.personId} = ${primary.id}`)
      .limit(1);
    if (existingRecord) {
      console.log(`  跳过（已有记录）：${company.name}`);
      continue;
    }

    const stage = scenario.stageKey ? stageByKey.get(scenario.stageKey) : undefined;
    const workflowState =
      scenario.scenario === "rejected" || scenario.scenario === "lost" ? "closed"
        : scenario.scenario === "new_lead" ? "unclassified"
          : scenario.scenario === "no_contact" ? "action_required"
            : "waiting";

    const [record] = await db.insert(crmRecords).values({
      organizationId: org.id,
      personId: primary.id,
      pipelineId: pipeline.id,
      categoryKey: stage?.categoryKey ?? null,
      subcategoryId: stage?.id ?? null,
      categorySource: stage ? "ai" : null,
      workflowState: workflowState as never,
      activeChannel: "email",
      closedReason: scenario.scenario === "rejected" ? "客户已有固定供应商"
        : scenario.scenario === "lost" ? "公司已注销" : null,
      lastInboundAt: null,
      lastOutboundAt: null,
      contextVersion: 0,
      createdAt: daysAgo(ctx.now, scenario.days, 9),
      updatedAt: daysAgo(ctx.now, scenario.days - 2, 15),
    }).returning({ id: crmRecords.id });
    stats.records += 1;

    // ---- 会话与消息 ----
    const conversation = CONVERSATIONS[company.name];
    let latestInboundId: string | null = null;
    if (conversation?.length) {
      const [conv] = await db.insert(crmConversations).values({
        organizationId: org.id,
        crmRecordId: record.id,
        personId: primary.id,
        channel: "email",
        accountRef: "sales@xinnongge.com",
        providerThreadId: `demo-${company.creditCode}`,
        providerContactId: primary.id,
        status: "active",
      }).returning({ id: crmConversations.id });
      stats.conversations += 1;

      for (const [index, message] of conversation.entries()) {
        const sentAt = daysAgo(ctx.now, message.dayOffset, 10 + index);
        const [row] = await db.insert(crmConversationMessages).values({
          conversationId: conv.id,
          personId: primary.id,
          channel: "email",
          accountRef: "sales@xinnongge.com",
          direction: message.direction,
          idempotencyKey: `demo-${company.creditCode}-${index}`,
          providerMessageId: `<demo-${company.creditCode}-${index}@xinnongge.com>`,
          subject: message.subject,
          bodyText: message.body,
          sentAt,
        }).returning({ id: crmConversationMessages.id });
        stats.messages += 1;
        if (message.direction === "inbound") latestInboundId = row.id;
      }

      // 记录上挂最新入站消息、更新互动时间——这是很多界面判断"该不该动手"的依据
      await db.execute(sql`
        update crm_records set
          latest_inbound_message_id = ${latestInboundId},
          last_inbound_at = (select max(sent_at) from crm_conversation_messages where conversation_id = ${conv.id} and direction = 'inbound'),
          last_outbound_at = (select max(sent_at) from crm_conversation_messages where conversation_id = ${conv.id} and direction = 'outbound'),
          last_interaction_at = (select max(sent_at) from crm_conversation_messages where conversation_id = ${conv.id})
        where id = ${record.id}
      `);

      // ---- AI 分类 ----
      if (latestInboundId) {
        const classification = CLASSIFICATIONS[company.name];
        if (classification) {
          await db.insert(crmClassifications).values({
            crmRecordId: record.id,
            messageId: latestInboundId,
            expectedContextVersion: 0,
            previousCategoryKey: null,
            previousSubcategoryId: null,
            proposedCategoryKey: classification.categoryKey as never,
            proposedSubcategoryId: stage?.id ?? null,
            appliedCategoryKey: classification.categoryKey as never,
            appliedSubcategoryId: stage?.id ?? null,
            // confidence 是 numeric，drizzle 要字符串
            confidence: classification.confidence.toFixed(4),
            reasoning: classification.reasoning,
            status: "auto_applied",
            provider: "openrouter",
            model: "deepseek/deepseek-chat",
            createdAt: daysAgo(ctx.now, scenario.days - 1, 11),
            updatedAt: daysAgo(ctx.now, scenario.days - 1, 11),
          }).onConflictDoNothing();
          stats.classifications += 1;
        }
      }

      // ---- AI 草稿（待审的才有价值展示）----
      const draftBody = DRAFTS[company.name];
      if (draftBody && scenario.scenario === "needs_reply" && latestInboundId) {
        await db.insert(crmDrafts).values({
          crmRecordId: record.id,
          conversationId: conv.id,
          replyForMessageId: latestInboundId,
          expectedContextVersion: 0,
          channel: "email",
          status: "awaiting_review",
          revision: 1,
          subject: draftBody.subject,
          aiBodyText: draftBody.body,
          provider: "openrouter",
          model: "deepseek/deepseek-chat",
          createdAt: daysAgo(ctx.now, 1, 11),
          updatedAt: daysAgo(ctx.now, 1, 11),
        }).onConflictDoNothing();
        stats.drafts += 1;
      }

      // ---- 阶段事件 ----
      if (stage) {
        await db.insert(crmEvents).values({
          organizationId: org.id,
          personId: primary.id,
          crmRecordId: record.id,
          pipelineId: pipeline.id,
          eventType: "record.created",
          actorType: "integration",
          toData: { cause: "prospect", source: "产品拓客" },
          contextVersion: 0,
          createdAt: daysAgo(ctx.now, scenario.days, 9),
        }).onConflictDoNothing();
        stats.events += 1;

        await db.insert(crmEvents).values({
          organizationId: org.id,
          personId: primary.id,
          crmRecordId: record.id,
          pipelineId: pipeline.id,
          eventType: "stage.moved",
          actorType: "ai",
          fromData: { subcategoryId: null },
          toData: { subcategoryId: stage.id, note: CLASSIFICATIONS[company.name]?.reasoning ?? null },
          contextVersion: 1,
          createdAt: daysAgo(ctx.now, scenario.days - 1, 11),
        }).onConflictDoNothing();
        stats.events += 1;
      }
    }

    // ---- 通话记录 ----
    const call = CALLS[company.name];
    if (call) {
      await db.insert(crmEvents).values({
        organizationId: org.id,
        personId: primary.id,
        crmRecordId: record.id,
        pipelineId: pipeline.id,
        eventType: "call.logged",
        actorType: "authenticated_operator",
        toData: {
          outcome: call.outcome,
          intent: call.intent,
          notes: call.notes,
          nextStep: call.nextStep ?? null,
          durationSeconds: call.duration ?? null,
          contactName: call.contactName ?? null,
        },
        contextVersion: 1,
        createdAt: daysAgo(ctx.now, call.dayOffset, 14),
      }).onConflictDoNothing();
      stats.events += 1;
    }

    // ---- 拜访 ----
    const visit = VISITS[company.name];
    if (visit) {
      const plannedAt = daysAgo(ctx.now, visit.plannedDayOffset, 10);
      // 计划事件——注意 visit 的 id 就是这个事件的 id
      const [planned] = await db.insert(crmEvents).values({
        organizationId: org.id,
        personId: primary.id,
        crmRecordId: record.id,
        pipelineId: pipeline.id,
        eventType: "visit.planned",
        actorType: "authenticated_operator",
        toData: { scheduledAt: plannedAt.toISOString(), location: visit.location, purpose: visit.purpose },
        contextVersion: 1,
        createdAt: daysAgo(ctx.now, visit.plannedDayOffset - 1, 16),
      }).returning({ id: crmEvents.id });
      stats.visits += 1;

      if (visit.completed) {
        await db.insert(crmEvents).values({
          organizationId: org.id,
          personId: primary.id,
          crmRecordId: record.id,
          pipelineId: pipeline.id,
          eventType: "visit.checked_in",
          actorType: "authenticated_operator",
          fromData: { status: "planned" },
          toData: { visitId: planned.id, checkedInAt: plannedAt.toISOString() },
          contextVersion: 1,
          createdAt: plannedAt,
        }).onConflictDoNothing();

        await db.insert(crmEvents).values({
          organizationId: org.id,
          personId: primary.id,
          crmRecordId: record.id,
          pipelineId: pipeline.id,
          eventType: "visit.completed",
          actorType: "authenticated_operator",
          fromData: { status: "checked_in" },
          toData: {
            visitId: planned.id,
            completedAt: new Date(plannedAt.getTime() + 90 * 60 * 1000).toISOString(),
            notes: visit.completed.notes,
            nextStep: visit.completed.nextStep,
            outcome: visit.completed.outcome,
          },
          contextVersion: 1,
          createdAt: new Date(plannedAt.getTime() + 90 * 60 * 1000),
        }).onConflictDoNothing();
      }
    }
  }

  // ---- Agent 运行记录：让"观测"页有东西可看 ----
  const runs = [
    { kind: "research", model: "deepseek/deepseek-chat", steps: 2, inputTokens: 1_840, outputTokens: 210, toolCalls: 2, durationMs: 4_120, dayOffset: 1 },
    { kind: "research", model: "deepseek/deepseek-chat", steps: 3, inputTokens: 2_460, outputTokens: 340, toolCalls: 3, durationMs: 6_880, dayOffset: 3 },
    { kind: "draft", model: "deepseek/deepseek-chat", steps: 1, inputTokens: 3_120, outputTokens: 480, toolCalls: 0, durationMs: 2_940, dayOffset: 5 },
    { kind: "classify", model: "deepseek/deepseek-chat", steps: 1, inputTokens: 1_260, outputTokens: 96, toolCalls: 0, durationMs: 1_820, dayOffset: 8 },
  ] as const;
  const existingRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(sql`${agentRuns.organizationId} = ${org.id}`)
    .limit(1);
  if (!existingRuns.length) {
    for (const run of runs) {
      const startedAt = daysAgo(ctx.now, run.dayOffset, 11);
      await db.insert(agentRuns).values({
        organizationId: org.id,
        kind: run.kind,
        status: "completed",
        model: run.model,
        steps: run.steps,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: (((run.inputTokens / 1000) * 0.00014) + ((run.outputTokens / 1000) * 0.00028)).toFixed(6),
        toolCalls: run.toolCalls,
        durationMs: run.durationMs,
        context: { note: "演示数据" },
        startedAt,
        finishedAt: new Date(startedAt.getTime() + run.durationMs),
      });
      stats.runs += 1;
    }
  }

  console.table(stats);
  console.log("\n演示数据已就绪。登录后按这个顺序看：");
  console.log("  1. /prospect        产品拓客（说一个产品 → 出名单）");
  console.log("  2. /crm/actions     待处理（有 AI 草稿等你看）");
  console.log("  3. /crm/pipeline    商机看板（8 家在漏斗不同位置）");
  console.log("  4. /visits          拜访（1 家已拜访、1 家待拜访）");
  console.log("  5. /leads           客户线索（702 联系人 + 这批坚果公司）");
  console.log("  6. /analytics       数据分析");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/** AI 对每条回复的分类判断。 */
const CLASSIFICATIONS: Record<string, { categoryKey: string; confidence: number; reasoning: string }> = {
  "杭州临安松鼠坚果食品有限公司": {
    categoryKey: "interested",
    confidence: 0.91,
    reasoning: "客户询问规格、起订量和能否做 OEM，并要求产品手册与检测报告，属于明确的资料索取意向。",
  },
  "宁波甬南食品贸易有限公司": {
    categoryKey: "interested",
    confidence: 0.86,
    reasoning: "客户收到报价后反馈价格对比，询问能否按目标价、以及账期，并说本周给答复，属于报价在谈。",
  },
  "苏州优鲜零食连锁有限公司": {
    categoryKey: "interested",
    confidence: 0.94,
    reasoning: "客户主动提出具体见面时间与地点，并要求带样品和规格表，属于明确约见。",
  },
  "合肥徽州记食品有限公司": {
    categoryKey: "interested",
    confidence: 0.88,
    reasoning: "客户邀请到厂里看产线并谈年度用量，属于实地考察邀约。",
  },
  "成都锦官城礼品有限公司": {
    categoryKey: "interested",
    confidence: 0.79,
    reasoning: "客户要求先看礼盒目录与报价区间，提到在对比多家，属于资料索取。",
  },
  "广州南粤供应链管理有限公司": {
    categoryKey: "not_interested",
    confidence: 0.93,
    reasoning: "客户明确表示已有固定供应商、暂无更换需求，属于已有供应商。",
  },
};

/** 待审草稿的内容——让销售能看到 AI 写了什么。 */
const DRAFTS: Record<string, { subject: string; body: string }> = {
  "杭州临安松鼠坚果食品有限公司": {
    subject: "Re: 新农哥 · 坚果原料与成品供货合作",
    body: "陈总您好，\n\n感谢您的回复。几个问题逐条回答：\n\n1）规格与起订量：山核桃仁现有 500g/1000g/5kg 三种规格，OEM 起订量 200 箱，常规货 50 箱起。\n2）OEM：可以做，包装设计我们来打样，确认后 15 天出第一批。\n3）手册与检测报告：随邮件附上产品目录和最近的第三方检测报告。\n\n关于货源，您提到现在从本地合作社拿货、量不大——如果主要顾虑是稳定性，我们可以先按季度的量报一个固定价，避免价格浮动。\n\n具体价格我按您的量单独出一版，明天发您。\n\n新农哥 · 销售",
  },
};

/** 通话记录。 */
const CALLS: Record<string, {
  outcome: string;
  intent: string;
  notes: string;
  nextStep?: string;
  duration?: number;
  contactName?: string;
  dayOffset: number;
}> = {
  "杭州临安松鼠坚果食品有限公司": {
    outcome: "connected",
    intent: "interested",
    notes: "接了电话，是陈总本人。问了 OEM 和起订量，说他们包装自己设计。提到现在从本地合作社拿货，量不大，主要顾虑是稳定性。",
    nextStep: "明天发产品手册 + 检测报告 + OEM 报价",
    duration: 420,
    contactName: "陈总",
    dayOffset: 2,
  },
  "宁波甬南食品贸易有限公司": {
    outcome: "transferred",
    intent: "needs_follow_up",
    notes: "前台转给采购部，周总不在。留了口信。第二天他回了邮件要报价。",
    nextStep: "等他本周答复，跟进账期问题",
    duration: 95,
    contactName: "前台",
    dayOffset: 6,
  },
  "上海禾丰电子商务有限公司": {
    outcome: "unreachable",
    intent: "unknown",
    notes: "打了两遍没人接，公示电话可能是总机。改走邮件。",
    duration: 0,
    dayOffset: 8,
  },
  "成都锦官城礼品有限公司": {
    outcome: "gatekeeper",
    intent: "needs_follow_up",
    notes: "前台说礼品采购由行政部负责，给了个分机号但没人接。",
    nextStep: "换时间再打，或者先加微信",
    duration: 60,
    contactName: "前台",
    dayOffset: 18,
  },
  "广州南粤供应链管理有限公司": {
    outcome: "rejected",
    intent: "not_interested",
    notes: "对方说已有固定供应商，明确不需要更换，态度客气但坚决。",
    duration: 45,
    dayOffset: 21,
  },
};

/** 拜访。 */
const VISITS: Record<string, {
  plannedDayOffset: number;
  location: string;
  purpose: string;
  completed: { notes: string; nextStep: string; outcome: "advanced" | "follow_up_needed" | "no_progress" } | null;
}> = {
  "苏州优鲜零食连锁有限公司": {
    plannedDayOffset: -6, // 未来：6 天后
    location: "苏州市工业园区 优鲜总部",
    purpose: "谈进店，带小包装样品和规格表",
    completed: null,
  },
  "合肥徽州记食品有限公司": {
    plannedDayOffset: 10, // 过去：10 天前
    location: "合肥市蜀山区 徽州记厂区",
    purpose: "看产线，谈今年用量",
    completed: {
      notes: "看了他们的炒货产线，日产能约 3 吨，目前原料主要从本地采购。胡厂长对临安山核桃的品质认可，但担心价格。带去的样品他留了两包做测试。",
      nextStep: "下周一前给一版年度框架价，按季度锁价",
      outcome: "advanced",
    },
  },
};
