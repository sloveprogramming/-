import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { crmPipelines, crmSettings, crmSubcategories, type CrmCategoryKey } from "./schema";

/**
 * The CRM an organization starts with: one default pipeline, its settings row
 * and the reply taxonomy (subcategories only — the sequences scripts/
 * seed-crm-response-taxonomy.ts writes are one company's copy, so a new
 * organization writes its own).
 *
 * Created lazily, on the first thing that needs "the default pipeline", so
 * nothing depends on a sign-up hook having run. Idempotent and race-safe: the
 * per-organization unique index crm_pipelines_org_one_default_uq arbitrates,
 * and the pipeline, settings and taxonomy commit together, so a caller that
 * loses the race sees the finished set. Subcategories are seeded only by the
 * call that creates the pipeline, so ones an operator later deletes stay gone.
 *
 * 改造：中文化 + 垂类聚焦新农哥。
 *
 * Two things changed from upstream:
 *
 * 1. The text is Chinese and worded for a food-distribution sales motion
 *    (样品 / 报价 / 试销) instead of a SaaS one (demo / trial / onboarding).
 *    Sales staff work in Chinese, and `classificationGuidance` is fed to the
 *    classifier verbatim, so it has to describe the reply in the words the
 *    customer actually uses.
 * 2. Each entry carries an explicit `key`. It used to be derived from
 *    `slugifySubcategoryKey(name)`, which strips non-ASCII: a Chinese name
 *    slugs to "" and falls back to a random key. Keys are identities — the
 *    state machine special-cases `do_not_contact`, sequences hang off them,
 *    and operators rename labels freely — so they are now written down, in
 *    English and stable, and only the human-readable fields are Chinese.
 */
export const DEFAULT_PIPELINE_NAME = "销售流程";

type DefaultSubcategory = {
  /** Stable identity. Never derive this from `name`; see the note above. */
  key: string;
  categoryKey: CrmCategoryKey;
  name: string;
  description: string;
  classificationGuidance: string;
  sortOrder: number;
  stageRank: number | null;
};

const DEFAULT_SUBCATEGORIES: readonly DefaultSubcategory[] = [
  {
    key: "do_not_contact",
    categoryKey: "not_interested",
    name: "勿扰名单",
    description: "对方明确要求不要再联系，或要求从触达名单中移除。",
    classificationGuidance: "仅用于对方明确表示退订、不要再联系、请移除或勿扰的情况。命中后必须停止一切触达：不分配回复序列，也不发送任何消息。",
    sortOrder: 10,
    stageRank: null,
  },
  {
    key: "not_required_right_now",
    categoryKey: "not_interested",
    name: "暂时不需要",
    description: "对方目前不需要，但不排除以后再谈。",
    classificationGuidance: "用于对方说现在不需要、时机不对、另有优先级，或让以后再来联系，但没有明确拒绝后续沟通的情况。",
    sortOrder: 20,
    stageRank: null,
  },
  {
    key: "already_using_a_tool_not_required",
    categoryKey: "not_interested",
    name: "已有供应商",
    description: "对方已有稳定的供货渠道或合作方，目前没有更换的打算。",
    classificationGuidance: "用于对方表示已有供应商、已和别的厂家合作、或内部渠道已经覆盖需求，因此暂时不需要我们的产品。",
    sortOrder: 30,
    stageRank: null,
  },
  {
    key: "information_requested",
    categoryKey: "interested",
    name: "索取资料",
    description: "对方索要产品资料、报价、规格、包装或公司信息。",
    classificationGuidance: "用于对方主要想要更多信息或答案，但没有明确要求样品、报价单、见面或试销的情况。",
    sortOrder: 10,
    stageRank: 1,
  },
  {
    key: "quote_requested",
    categoryKey: "interested",
    name: "索取报价",
    description: "对方要价格、要报价单、问批发价或代理价。",
    classificationGuidance: "用于对方明确询问价格、要报价单、问批发价/代理价/一件代发价，或要求给出不同规格的价盘。",
    sortOrder: 20,
    stageRank: 3,
  },
  {
    key: "case_study",
    categoryKey: "interested",
    name: "要看案例",
    description: "对方想看合作案例、客户见证或同类渠道的销售情况。",
    classificationGuidance: "用于对方明确索要案例、参考客户、合作门店、同类渠道的销售数据或效果证明。",
    sortOrder: 30,
    stageRank: 1,
  },
  {
    key: "meeting_requested",
    categoryKey: "interested",
    name: "想约见",
    description: "对方希望安排见面、电话沟通或来访考察。",
    classificationGuidance: "用于对方提出要见面、打电话详谈、到厂考察或安排时间沟通，包括询问什么时候方便。",
    sortOrder: 40,
    stageRank: 4,
  },
  {
    key: "meeting_no_show",
    categoryKey: "interested",
    name: "约见未到",
    description: "约好的见面或电话没有进行，对方未到场。",
    classificationGuidance: "用于约定时间已过、对方未出席，或对方主动说明错过了这次沟通的情况。",
    sortOrder: 50,
    stageRank: 4,
  },
  {
    key: "meeting_done",
    categoryKey: "interested",
    name: "已见面",
    description: "见面或电话已完成，接下来应发纪要和下一步动作。",
    classificationGuidance: "用于沟通已经发生，下一步回复应当回顾谈了什么、定了什么、谁负责什么、接下来做什么。",
    sortOrder: 60,
    stageRank: 5,
  },
  {
    key: "demo_request",
    categoryKey: "interested",
    name: "索要样品",
    description: "对方要求寄样品、试吃或看实物。",
    classificationGuidance: "用于对方明确要求寄样、试吃、看实物、要产品手册或安排品鉴。",
    sortOrder: 70,
    stageRank: 2,
  },
  {
    key: "trial_requested",
    categoryKey: "interested",
    name: "想试销",
    description: "对方想先进一小批试销，或询问试销政策。",
    classificationGuidance: "用于对方提出先进小批量试销、试卖、代销，或询问试销/铺货政策与门槛。",
    sortOrder: 80,
    stageRank: 6,
  },
  {
    key: "trial_user",
    categoryKey: "interested",
    name: "试销中",
    description: "对方已经在试销，需要跟进动销、补货或陈列。",
    classificationGuidance: "用于对方已经在试销或铺货，话题是动销、补货、陈列、促销支持，而不是最初的政策咨询。",
    sortOrder: 90,
    stageRank: 7,
  },
  {
    key: "customer",
    categoryKey: "customer",
    name: "已成交客户",
    description: "对方是已成交客户，在谈对账、返点、续单或售后。",
    classificationGuidance: "用于对方已经是成交客户，对话涉及订单、对账、返点、补货、售后或长期合作。",
    sortOrder: 10,
    stageRank: 8,
  },
  {
    key: "did_not_connect_to_different_poc",
    categoryKey: "other",
    name: "找错人（未给对接人）",
    description: "对方不是负责采购的人，也没有提供或引荐合适的人。",
    classificationGuidance: "用于对方说自己不是负责人，但没有给出其他联系人、也没有转介绍的情况。",
    sortOrder: 10,
    stageRank: null,
  },
  {
    key: "connected_to_different_poc",
    categoryKey: "other",
    name: "已转介对接人",
    description: "对方把合适的对接人介绍给了我们，或提供了其联系方式。",
    classificationGuidance: "用于对方提供了另一个人的联系方式、把对方拉进对话，或直接做了转介绍。",
    sortOrder: 20,
    stageRank: null,
  },
  {
    key: "left_company",
    categoryKey: "other",
    name: "已离职",
    description: "对方已经不在该公司任职。",
    classificationGuidance: "用于自动回复、同事或其他可靠消息说明该人已离职的情况。",
    sortOrder: 30,
    stageRank: null,
  },
  {
    key: "out_of_office",
    categoryKey: "other",
    name: "休假中",
    description: "对方暂时不在岗，收到了休假或外出的自动回复。",
    classificationGuidance: "用于短期的休假、出差、不在岗自动回复。如果消息说明对方已永久离职，不要用这一项。",
    sortOrder: 40,
    stageRank: null,
  },
  {
    key: "other",
    categoryKey: "other",
    name: "其他",
    description: "不属于以上任何分类，需要结合上下文单独回复。",
    classificationGuidance: "仅在没有其他分类匹配时使用。只要意图能判断清楚，优先选具体分类。",
    sortOrder: 50,
    stageRank: null,
  },
];

/** The id of the organization in scope's default pipeline, creating the defaults if it has none. */
export async function ensureCrmDefaults(): Promise<{ pipelineId: string; created: boolean }> {
  const findDefault = async () => {
    const [pipeline] = await db
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(and(inOrg(crmPipelines), eq(crmPipelines.isDefault, true)))
      .limit(1);
    return pipeline?.id ?? null;
  };
  const existing = await findDefault();
  if (existing) return { pipelineId: existing, created: false };

  const organizationId = currentOrganizationId();
  const created = await db.transaction(async (tx) => {
    const [pipeline] = await tx
      .insert(crmPipelines)
      .values({ organizationId, name: DEFAULT_PIPELINE_NAME, isDefault: true, active: true })
      .onConflictDoNothing()
      .returning({ id: crmPipelines.id });
    if (!pipeline) return null;
    await tx.insert(crmSettings).values({ pipelineId: pipeline.id }).onConflictDoNothing();
    await tx
      .insert(crmSubcategories)
      .values(DEFAULT_SUBCATEGORIES.map((entry) => ({
        pipelineId: pipeline.id,
        categoryKey: entry.categoryKey,
        key: entry.key,
        name: entry.name,
        description: entry.description,
        classificationGuidance: entry.classificationGuidance,
        sortOrder: entry.sortOrder,
        stageRank: entry.stageRank,
      })))
      .onConflictDoNothing();
    return pipeline.id;
  });
  if (created) return { pipelineId: created, created: true };

  // Lost the race (or the name is taken by a non-default pipeline): the
  // winner's transaction has committed by the time the insert gave up.
  const winner = await findDefault();
  if (!winner) throw new Error("The organization's default CRM pipeline could not be created");
  return { pipelineId: winner, created: false };
}
