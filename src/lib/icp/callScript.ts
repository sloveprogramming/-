/**
 * 电话话术生成：按"产品 × 客户类型 × 公司情况"拼出一通电话要说的东西。
 *
 * 与 openers.ts 的区别：openers 是**按客户类型**的通用首触（经销商怎么说、连锁怎么说），
 * 这里是**按具体产品和具体公司**的定制——销售拿到一个陌生公司，要知道"我卖面包丝，
 * 打给这家烘焙厂，第一句说什么"。
 *
 * 结构刻意做成四段，因为一通电话的成败在结构而不在措辞：
 *
 *   开场（15 秒）  自报家门 + 说明来意 —— 决定对方会不会挂
 *   探询（30 秒）  问出对方现状 —— 决定你后面能不能说对
 *   价值（30 秒）  针对他刚才说的，给出一个具体的好处
 *   收尾（15 秒）  要一个低成本动作（发资料 / 加微信 / 约时间）
 *
 * 不做成"一整段稿子"是有意的：整段稿子念起来像机器，销售也记不住。
 * 四段短句可以扫一眼就说。
 */

import type { IcpSegmentKey } from "./segments";
import type { ProductIntent } from "./productIntent";

export type CallScriptSegment = {
  key: "opening" | "probing" | "value" | "closing";
  label: string;
  /** 建议时长（秒），用于界面提示节奏。 */
  seconds: number;
  /** 要说的内容，带占位符。 */
  text: string;
  /** 这一段的目标。 */
  goal: string;
};

export type CallScript = {
  /** 通话对象：公司名 + 联系人（可能只有公司）。 */
  companyName: string;
  contactName: string | null;
  /** 产品意图，决定话术里的品类与买家描述。 */
  product: ProductIntent;
  segment: IcpSegmentKey | null;
  segments: CallScriptSegment[];
  /** 对方可能问的问题 + 该怎么答。 */
  objections: Array<{ question: string; answer: string }>;
  /** 打完这通电话要拿到的东西。 */
  mustGet: string[];
  /** 不该说的话。 */
  avoid: string[];
};

const COMPANY_PLACEHOLDER = "{company}";
const NAME_PLACEHOLDER = "{name}";
const REP_PLACEHOLDER = "{rep}";

/** 按客户类型给"开场"的落点：不同角色关心的东西不一样。 */
const OPENING_BY_SEGMENT: Record<IcpSegmentKey, (product: string) => string> = {
  distributor: (product) =>
    `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}，做食品原料/成品供应。` +
    `看到${COMPANY_PLACEHOLDER}在做食品分销，想跟您确认一下——${product}这条线，您现在是从哪家进的货？`,
  retail_chain: (product) =>
    `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}。` +
    `想找${COMPANY_PLACEHOLDER}负责${product}这一块的采购，方便帮我转一下，或者告诉我找哪位吗？`,
  ecommerce_reseller: (product) =>
    `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}，做${product}的厂家。` +
    `看到您店里有卖这类产品，想问下现在是自己备货还是找代发？`,
  corporate_gifting: (product) =>
    `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}。` +
    `想问下${COMPANY_PLACEHOLDER}今年的节日福利在筹备吗？我们做${product}礼盒，可以直接对接工厂。`,
  live_commerce: (product) =>
    `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}，${product}的厂家。` +
    `我们给达人做过食品类目的专场，想问下这类品您这边有没有在选？`,
  special_channel: (product) =>
    `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}。` +
    `我们有生产线，能按规格做${product}，想问下${COMPANY_PLACEHOLDER}这块现在有没有在找供应？`,
};

/** 兜底开场：客户类型不明时，用最中性的版本，不假设对方是做什么的。 */
const GENERIC_OPENING = (product: string) =>
  `${NAME_PLACEHOLDER}您好，我是新农哥的${REP_PLACEHOLDER}，做${product}的厂家。` +
  `请问${COMPANY_PLACEHOLDER}这边${product}相关的东西是哪位在负责？`;

export function buildCallScript(input: {
  product: ProductIntent;
  companyName: string;
  contactName?: string | null;
  segment?: IcpSegmentKey | null;
  /** 销售自己的名字，放进话术里。 */
  repName?: string | null;
}): CallScript {
  const productName = input.product.query || "这个产品";
  const segment = input.segment ?? input.product.segment ?? null;
  const opening = segment ? OPENING_BY_SEGMENT[segment](productName) : GENERIC_OPENING(productName);
  const buyer = input.product.buyerDescription;

  const segments: CallScriptSegment[] = [
    {
      key: "opening",
      label: "开场",
      seconds: 15,
      text: opening,
      goal: "让对方听你说完，并说出他现在的情况。不要在这段就开始介绍公司。",
    },
    {
      key: "probing",
      label: "探询",
      seconds: 30,
      text:
        `顺着对方的回答问三件事：\n` +
        `1. 现在这条线是谁在供？\n` +
        `2. 采购上最在意什么——价格、账期，还是供货稳不稳？\n` +
        `3. 一年大概走多少量？`,
      goal: "拿到真实需求。这三个问题不答完，不要报价。",
    },
    {
      key: "value",
      label: "价值",
      seconds: 30,
      text:
        `针对他刚说的顾虑，只讲**一个**对应的点，别把优势全倒一遍：\n` +
        `- 嫌贵 → 讲产地直采和规格拆分；\n` +
        `- 嫌不稳 → 讲自有生产线和供货周期；\n` +
        `- 嫌不好卖 → 讲同区域已有客户的实际动销。\n` +
        `然后一句：「${buyer}这块我们做得比较多，具体数据我发您看。」`,
      goal: "让他觉得你懂他这一行，而不是在背产品说明。",
    },
    {
      key: "closing",
      label: "收尾",
      seconds: 15,
      text:
        `要一个成本最低的动作，只选一个：\n` +
        `- 「我加您个微信，把资料发您？」\n` +
        `- 「我先寄个样品过来，您试了再说？」\n` +
        `- 「方便的话约 15 分钟，我带样品过去？」\n` +
        `确认后当场记下来，别只说「那我再联系您」。`,
      goal: "拿到一个明确的下一步，否则这通电话等于没打。",
    },
  ];

  return {
    companyName: input.companyName,
    contactName: input.contactName?.trim() || null,
    product: input.product,
    segment,
    segments,
    objections: [
      {
        question: "「你们是哪家？」",
        answer: "新农哥，杭州临安做坚果和食品原料的厂家，做了快 20 年。",
      },
      {
        question: "「现在不需要 / 我们有固定的供应商。」",
        answer: "理解。那我先不下结论——您留个微信，我把价盘发过去，您对比一下，不合适就放着。",
      },
      {
        question: "「多少钱？」",
        answer: "价格要看规格和量，我现在报不准。您方便说下大概的量吗？我按您的量出一版正式的。",
      },
      {
        question: "「先发资料我看看。」",
        answer: "好，我加您微信发。顺便问一句：您现在最想解决的问题是价格还是供货？我按这个重点整理。",
      },
    ],
    mustGet: [
      "这条线现在谁在供",
      "一年大概多少量",
      "最在意的是价格、账期还是供货稳定",
      "负责人的微信或手机号",
    ],
    avoid: [
      "不要在对方说需求之前先报价",
      "不要承诺独家区域、账期、返点——这些要正式审批",
      "不要一口气把产品线全念一遍",
      "不要说「打扰您几分钟」这种把自己放低的开场",
    ],
  };
}

/** 把话术渲染成纯文本（复制到手机、或贴进 CRM 备注用）。 */
export function renderCallScriptText(
  script: CallScript,
  values: { name?: string | null; rep?: string | null } = {},
): string {
  const fill = (text: string) =>
    text
      .replaceAll(COMPANY_PLACEHOLDER, script.companyName)
      .replaceAll(NAME_PLACEHOLDER, values.name?.trim() || "您")
      .replaceAll(REP_PLACEHOLDER, values.rep?.trim() || "我");

  const lines: string[] = [
    `【电话】${script.companyName}${script.contactName ? ` · ${script.contactName}` : ""}`,
    `产品：${script.product.query}${script.product.category ? `（${script.product.category}）` : ""}`,
    "",
  ];
  for (const part of script.segments) {
    lines.push(`— ${part.label}（约 ${part.seconds} 秒）`, fill(part.text), "");
  }
  lines.push("— 对方可能会问", ...script.objections.map((item) => `  ${item.question} → ${item.answer}`), "");
  lines.push("— 这通电话必须拿到", ...script.mustGet.map((item) => `  □ ${item}`), "");
  lines.push("— 不要说", ...script.avoid.map((item) => `  × ${item}`));
  return lines.join("\n");
}
