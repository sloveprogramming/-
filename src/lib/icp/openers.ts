/**
 * 中文首触话术。
 *
 * 这些不是"模板引擎"，是给销售和 AI 起草用的**口径**：国内 B2B 的第一句话
 * 决定后面还有没有对话。写的时候守四条：
 *
 *   1. 自报家门 ≤ 15 字，说清是谁、在哪、做什么；
 *   2. 给对方一个"这跟我有关"的理由，不要一上来就介绍公司；
 *   3. 结尾给一个**低成本动作**（发份报价 / 加个微信 / 三分钟电话），不要"期待合作"；
 *   4. 不承诺价格、返点、独家区域——这些一律推给正式报价。
 *
 * 渠道特性：短信一条 70 字内、企微可以两三句、电话要 30 秒说完、邮件只用于正式文件。
 */

import type { IcpSegmentKey } from "./segments";
import { XINNONGGE } from "./profile";

export type OpenerChannel = "sms" | "wecom" | "call" | "email";

export type OpenerTemplate = {
  channel: OpenerChannel;
  /** 使用场景一句话。 */
  when: string;
  /** 带占位符的模板：{name} {company} {rep} {city}。 */
  body: string;
  /** 这一版要注意什么。 */
  notes?: string;
};

const SIGNATURE = `${XINNONGGE.shortName}`;

/** 每类客户的首触话术。 */
const OPENERS: Record<IcpSegmentKey, readonly OpenerTemplate[]> = {
  distributor: [
    {
      channel: "call",
      when: "第一次打电话，30 秒版",
      body:
        "{name}您好，耽误您一分钟。我是" + SIGNATURE + "的{rep}，临安做坚果炒货快 20 年的厂家。" +
        "看您这边在做休闲食品分销，想问下您山核桃和每日坚果这条线现在是谁在供？" +
        "我们今年在拓{city}的区域代理，政策是区域独家、首批搭赠、派驻业务员。",
      notes: "先问对方现状，再报我们的政策；对方如果愿意聊，直接约 15 分钟面谈或寄样。",
    },
    {
      channel: "wecom",
      when: "加了微信之后的第一条",
      body:
        "{name}您好，我是刚才电话里的{rep}，" + SIGNATURE + "的。\n" +
        "我们是临安的坚果厂家，山核桃仁、每日坚果、风味坚果都是自己的线。\n" +
        "您方便的话我发一份区域代理的政策和价盘给您，先看看合不合适？",
      notes: "不要一上来发产品图；先给「政策 + 价盘」这个对方真正关心的东西。",
    },
    {
      channel: "sms",
      when: "没有微信、电话没接时补一条",
      body: "{name}您好，我是" + SIGNATURE + "的{rep}，临安坚果厂家，做区域代理和一件代发。方便的话回个电话，我发份价盘给您。",
      notes: "70 字以内，带身份和来意，结尾给动作。",
    },
  ],
  retail_chain: [
    {
      channel: "call",
      when: "找采购负责人",
      body:
        "{name}您好，我是" + SIGNATURE + "的{rep}，临安做坚果炒货的厂家。" +
        "想找咱们{company}的采购对接一下——我们山核桃仁、每日坚果、年节礼盒都能供，" +
        "能不能给我一个负责坚果品类的同事的联系方式？",
      notes: "连锁体系里前台转接成功率高，重点是拿到采购的联系方式而不是当场推销。",
    },
    {
      channel: "wecom",
      when: "采购加上之后",
      body:
        "{name}您好，我是" + SIGNATURE + "的{rep}。\n" +
        "我们主做山核桃仁、每日坚果和礼盒，有自己的生产线，能给到稳定的供货价。\n" +
        "方便的话我按贵司的规格出一版报价，另外可以寄样试吃。",
      notes: "连锁采购关心三件事：供货价、稳定性、退换。先把这三个说清。",
    },
    {
      channel: "email",
      when: "正式报价与资质文件",
      body:
        "主题：" + SIGNATURE + " × {company}｜坚果炒货供货方案\n\n" +
        "{name}您好：\n\n" +
        "附件是我们针对贵司渠道整理的产品清单与供货方案，包含：\n" +
        "1. 主推单品与规格（山核桃仁、每日坚果、风味坚果、礼盒）\n" +
        "2. 分规格供货价与最小起订量\n" +
        "3. 供货周期与退换货规则\n\n" +
        "如果需要样品，回复地址我安排寄出。\n\n{rep}\n" + SIGNATURE,
      notes: "邮件只用于正式文件，不做首触。附件里不要放未确认的数字。",
    },
  ],
  ecommerce_reseller: [
    {
      channel: "wecom",
      when: "找到店铺老板",
      body:
        "{name}您好，我是" + SIGNATURE + "的{rep}，临安的坚果厂家。\n" +
        "看到您店里在卖坚果，我们支持一件代发，不用压货，山核桃仁和每日坚果都是现货。\n" +
        "发您一份代发价目表？",
      notes: "电商卖家只关心两件事：代发价、发货速度。先给这两项。",
    },
    {
      channel: "sms",
      when: "私信没回",
      body: "{name}您好，我是" + SIGNATURE + "的{rep}，坚果厂家，支持一件代发、不压货。方便加个微信发您代发价目表吗？",
    },
  ],
  corporate_gifting: [
    {
      channel: "call",
      when: "节前 2 个月找行政/工会",
      body:
        "{name}您好，我是" + SIGNATURE + "的{rep}，临安做坚果礼盒的厂家。" +
        "想问下咱们今年的节日福利是不是在筹备了？我们可以按预算做定制礼盒，直接对接工厂，中间不加价。",
      notes: "团购的关键是预算区间和交付时间，先问这两项。",
    },
    {
      channel: "email",
      when: "发方案",
      body:
        "主题：" + SIGNATURE + "｜{company} 节日福利礼盒方案\n\n" +
        "{name}您好：\n\n" +
        "按常见预算档位整理了三套礼盒方案（含包装、含税、含运），附件可直接对比。\n" +
        "如果贵司有既定的预算区间和交付时间，回复我，我按需重新配。\n\n{rep}\n" + SIGNATURE,
    },
  ],
  live_commerce: [
    {
      channel: "wecom",
      when: "商务对接",
      body:
        "{name}您好，我是" + SIGNATURE + "的{rep}，临安坚果厂家。\n" +
        "我们有山核桃仁、每日坚果、风味坚果几条线，适合食品类目直播，支持专属机制和一件代发。\n" +
        "方便的话我把货盘和佣金方案发您？",
      notes: "达人关心的是机制（价格优势）和佣金，不是公司历史。",
    },
  ],
  special_channel: [
    {
      channel: "call",
      when: "特通渠道首触",
      body:
        "{name}您好，我是" + SIGNATURE + "的{rep}，临安坚果厂家。" +
        "我们有自有生产线，可以按贵司的规格做小包装或定制款，想问下这块现在有没有在找供应？",
      notes: "特通渠道多是定制需求，先问规格与起订量。",
    },
  ],
};

export function openersFor(segment: IcpSegmentKey): readonly OpenerTemplate[] {
  return OPENERS[segment];
}

/** 合并占位符。缺的字段留空，不写「undefined」。 */
export function renderOpener(
  template: string,
  values: Partial<Record<"name" | "company" | "rep" | "city", string | null | undefined>>,
): string {
  return template.replace(/\{(name|company|rep|city)\}/g, (_, key: "name" | "company" | "rep" | "city") => {
    const value = values[key];
    return value?.trim() ? value.trim() : "您";
  });
}

/** 渲染成 Markdown，作为「首触话术」知识文档写进 CRM。 */
export function renderOpenersBrief(): string {
  const lines: string[] = [
    "# 首触话术",
    "",
    "四条原则：自报家门 ≤15 字；给对方一个「这跟我有关」的理由；结尾给一个低成本动作；不承诺价格、返点、独家区域。",
    "",
    "占位符：{name} 对方称呼、{company} 对方公司、{rep} 我们的销售、{city} 城市。",
    "",
  ];
  const channelName: Record<OpenerChannel, string> = { sms: "短信", wecom: "企业微信", call: "电话", email: "邮件" };
  const segmentName: Record<IcpSegmentKey, string> = {
    distributor: "区域经销商 / 代理商",
    retail_chain: "零食连锁 / 商超采购",
    ecommerce_reseller: "电商分销商",
    corporate_gifting: "企业团购 / 福利礼品",
    live_commerce: "直播带货 MCN / 达人",
    special_channel: "特通渠道",
  };
  for (const key of Object.keys(OPENERS) as IcpSegmentKey[]) {
    lines.push(`## ${segmentName[key]}`, "");
    for (const opener of OPENERS[key]) {
      lines.push(`**${channelName[opener.channel]}**（${opener.when}）`, "", "```", opener.body, "```", "");
      if (opener.notes) lines.push(`> ${opener.notes}`, "");
    }
  }
  // trim：知识库那边存的是 trim 过的文本，这里也对齐，否则每次 seed 都会被判成"变了"。
  return lines.join("\n").trim();
}
