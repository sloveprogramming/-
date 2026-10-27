/**
 * 中文化：把已经建好的组织的 CRM 回复分类翻成中文。
 *
 * Run with:  bun --conditions=react-server scripts/zh-crm-taxonomy.ts
 *
 * 背景：`DEFAULT_SUBCATEGORIES`（src/lib/crm/defaults.ts）已改成中文，但它只在
 * 组织第一次创建默认流程时执行一次。已经存在的组织（演示库、上线后已开号的组织）
 * 仍然是英文的分类名、英文的描述和英文的分类指引——而分类指引是直接喂给 AI 分类器
 * 的，不翻就等于没改。
 *
 * 做法：
 *   1. crm_categories（全局固定的四个顶级分类）标签改成中文。
 *   2. 每个组织的默认流程名 "Default" → "销售流程"。
 *   3. 每个默认流程下，按 key 更新子分类的中文名/描述/指引/排序/漏斗位次；
 *      缺少的 key（新增的 quote_requested）补插。
 *
 * 只改「看起来还没被人工改过」的行：更新条件带上英文原名。运营自己改过名字的
 * 子分类整行跳过，不覆盖人工配置。可重复执行。
 */
import { Client } from "pg";

type Entry = {
  key: string;
  categoryKey: "customer" | "interested" | "not_interested" | "other";
  /** 上游的英文名：命中它才认为是没被人工改过的行。 */
  oldName: string;
  name: string;
  description: string;
  guidance: string;
  sortOrder: number;
  stageRank: number | null;
};

const TAXONOMY: readonly Entry[] = [
  { key: "do_not_contact", categoryKey: "not_interested", oldName: "Do Not Contact", name: "勿扰名单", description: "对方明确要求不要再联系，或要求从触达名单中移除。", guidance: "仅用于对方明确表示退订、不要再联系、请移除或勿扰的情况。命中后必须停止一切触达：不分配回复序列，也不发送任何消息。", sortOrder: 10, stageRank: null },
  { key: "not_required_right_now", categoryKey: "not_interested", oldName: "Not Required Right Now", name: "暂时不需要", description: "对方目前不需要，但不排除以后再谈。", guidance: "用于对方说现在不需要、时机不对、另有优先级，或让以后再来联系，但没有明确拒绝后续沟通的情况。", sortOrder: 20, stageRank: null },
  { key: "already_using_a_tool_not_required", categoryKey: "not_interested", oldName: "Already Using a Tool — Not Required", name: "已有供应商", description: "对方已有稳定的供货渠道或合作方，目前没有更换的打算。", guidance: "用于对方表示已有供应商、已和别的厂家合作、或内部渠道已经覆盖需求，因此暂时不需要我们的产品。", sortOrder: 30, stageRank: null },
  { key: "information_requested", categoryKey: "interested", oldName: "Information Requested", name: "索取资料", description: "对方索要产品资料、报价、规格、包装或公司信息。", guidance: "用于对方主要想要更多信息或答案，但没有明确要求样品、报价单、见面或试销的情况。", sortOrder: 10, stageRank: 1 },
  { key: "quote_requested", categoryKey: "interested", oldName: "", name: "索取报价", description: "对方要价格、要报价单、问批发价或代理价。", guidance: "用于对方明确询问价格、要报价单、问批发价/代理价/一件代发价，或要求给出不同规格的价盘。", sortOrder: 20, stageRank: 3 },
  { key: "case_study", categoryKey: "interested", oldName: "Case Study", name: "要看案例", description: "对方想看合作案例、客户见证或同类渠道的销售情况。", guidance: "用于对方明确索要案例、参考客户、合作门店、同类渠道的销售数据或效果证明。", sortOrder: 30, stageRank: 1 },
  { key: "meeting_requested", categoryKey: "interested", oldName: "Meeting Requested", name: "想约见", description: "对方希望安排见面、电话沟通或来访考察。", guidance: "用于对方提出要见面、打电话详谈、到厂考察或安排时间沟通，包括询问什么时候方便。", sortOrder: 40, stageRank: 4 },
  { key: "meeting_no_show", categoryKey: "interested", oldName: "Meeting No Show", name: "约见未到", description: "约好的见面或电话没有进行，对方未到场。", guidance: "用于约定时间已过、对方未出席，或对方主动说明错过了这次沟通的情况。", sortOrder: 50, stageRank: 4 },
  { key: "meeting_done", categoryKey: "interested", oldName: "Meeting Done", name: "已见面", description: "见面或电话已完成，接下来应发纪要和下一步动作。", guidance: "用于沟通已经发生，下一步回复应当回顾谈了什么、定了什么、谁负责什么、接下来做什么。", sortOrder: 60, stageRank: 5 },
  { key: "demo_request", categoryKey: "interested", oldName: "Demo Request", name: "索要样品", description: "对方要求寄样品、试吃或看实物。", guidance: "用于对方明确要求寄样、试吃、看实物、要产品手册或安排品鉴。", sortOrder: 70, stageRank: 2 },
  { key: "trial_requested", categoryKey: "interested", oldName: "Trial Requested", name: "想试销", description: "对方想先进一小批试销，或询问试销政策。", guidance: "用于对方提出先进小批量试销、试卖、代销，或询问试销/铺货政策与门槛。", sortOrder: 80, stageRank: 6 },
  { key: "trial_user", categoryKey: "interested", oldName: "Trial User", name: "试销中", description: "对方已经在试销，需要跟进动销、补货或陈列。", guidance: "用于对方已经在试销或铺货，话题是动销、补货、陈列、促销支持，而不是最初的政策咨询。", sortOrder: 90, stageRank: 7 },
  { key: "customer", categoryKey: "customer", oldName: "Customer", name: "已成交客户", description: "对方是已成交客户，在谈对账、返点、续单或售后。", guidance: "用于对方已经是成交客户，对话涉及订单、对账、返点、补货、售后或长期合作。", sortOrder: 10, stageRank: 8 },
  { key: "did_not_connect_to_different_poc", categoryKey: "other", oldName: "Did Not Connect to Different POC", name: "找错人（未给对接人）", description: "对方不是负责采购的人，也没有提供或引荐合适的人。", guidance: "用于对方说自己不是负责人，但没有给出其他联系人、也没有转介绍的情况。", sortOrder: 10, stageRank: null },
  { key: "connected_to_different_poc", categoryKey: "other", oldName: "Connected to Different POC", name: "已转介对接人", description: "对方把合适的对接人介绍给了我们，或提供了其联系方式。", guidance: "用于对方提供了另一个人的联系方式、把对方拉进对话，或直接做了转介绍。", sortOrder: 20, stageRank: null },
  { key: "left_company", categoryKey: "other", oldName: "Left Company", name: "已离职", description: "对方已经不在该公司任职。", guidance: "用于自动回复、同事或其他可靠消息说明该人已离职的情况。", sortOrder: 30, stageRank: null },
  { key: "out_of_office", categoryKey: "other", oldName: "Out of Office", name: "休假中", description: "对方暂时不在岗，收到了休假或外出的自动回复。", guidance: "用于短期的休假、出差、不在岗自动回复。如果消息说明对方已永久离职，不要用这一项。", sortOrder: 40, stageRank: null },
  { key: "other", categoryKey: "other", oldName: "Other", name: "其他", description: "不属于以上任何分类，需要结合上下文单独回复。", guidance: "仅在没有其他分类匹配时使用。只要意图能判断清楚，优先选具体分类。", sortOrder: 50, stageRank: null },
];

/**
 * 顶级分类（crm_categories）的四个标签**不在这里改**：那张表是系统所有，
 * crm_categories_protect_system_rows() 触发器会拒绝任何对系统行的修改。
 * 所以 "Interested / Customer / Not Interested / Other" 只在展示层映射成中文，
 * 见 src/lib/crm/labels.ts。
 */

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '2min'");
    await client.query("BEGIN");

    // 1. 默认流程名
    await client.query(
      `UPDATE crm_pipelines SET name = '销售流程', updated_at = now()
        WHERE is_default IS TRUE AND name = 'Default'`,
    );

    // 2. 每个默认流程下的子分类
    const { rows: pipelines } = await client.query<{ id: string }>(
      "SELECT id FROM crm_pipelines WHERE is_default IS TRUE",
    );
    let renamed = 0;
    let inserted = 0;
    for (const pipeline of pipelines) {
      for (const entry of TAXONOMY) {
        if (entry.oldName) {
          const updated = await client.query(
            `UPDATE crm_subcategories
                SET name = $3, description = $4, classification_guidance = $5,
                    sort_order = $6, stage_rank = $7, updated_at = now()
              WHERE pipeline_id = $1 AND key = $2 AND name = $8`,
            [pipeline.id, entry.key, entry.name, entry.description, entry.guidance,
             entry.sortOrder, entry.stageRank, entry.oldName],
          );
          renamed += updated.rowCount ?? 0;
        }
        const result = await client.query(
          `INSERT INTO crm_subcategories
             (pipeline_id, category_key, key, name, description, classification_guidance, sort_order, stage_rank)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (pipeline_id, key) DO NOTHING`,
          [pipeline.id, entry.categoryKey, entry.key, entry.name, entry.description,
           entry.guidance, entry.sortOrder, entry.stageRank],
        );
        inserted += result.rowCount ?? 0;
      }
    }

    await client.query("COMMIT");

    const { rows } = await client.query(
      `SELECT category_key, key, name, stage_rank FROM crm_subcategories
        ORDER BY category_key, sort_order`,
    );
    console.table(rows);
    console.log(`流程数 ${pipelines.length}｜改名 ${renamed} 行｜补插 ${inserted} 行`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
