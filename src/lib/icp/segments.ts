/**
 * 新农哥的六类目标客户。
 *
 * 改造前这个系统只能拓「有独立站、装了 Shopify 应用、Apollo 里有联系人」的欧美
 * 电商卖家——那不是行业，是渠道生态决定的客户集合。换成新农哥之后，客户画像
 * 由业务决定：**能帮我们把坚果卖出去的人**。
 *
 * 每一类都写清楚三件事：长什么样（profile）、凭什么判断（signals）、去哪儿找
 * （sources）。评分模型和首触话术都从这里取。
 *
 * 优先级是建议值，需要公司用实际增长数据确认（P0 不代表现在就该全压上去）。
 */

export type IcpPriority = "P0" | "P1" | "P2" | "P3";

export type IcpSegment = {
  key: IcpSegmentKey;
  name: string;
  priority: IcpPriority;
  /** 典型画像：规模、地域、手里有什么资源。 */
  profile: string;
  /** 判断信号：能在公开数据或沟通里观察到的。 */
  signals: readonly string[];
  /** 数据源：去哪儿找这类客户。 */
  sources: readonly string[];
  /** 首触渠道：国内这类客户实际怎么被联系上的。 */
  firstTouch: string;
  /** 排除条件：看起来像但不是。 */
  disqualifiers: readonly string[];
};

export type IcpSegmentKey =
  | "distributor"
  | "retail_chain"
  | "ecommerce_reseller"
  | "corporate_gifting"
  | "live_commerce"
  | "special_channel";

export const ICP_SEGMENTS: readonly IcpSegment[] = [
  {
    key: "distributor",
    name: "区域经销商 / 代理商",
    priority: "P0",
    profile: "省市级休闲食品、坚果炒货经销商，手里有商超、流通或便利店网络，年营收 1000 万–5 亿",
    signals: [
      "经营范围含「预包装食品销售」，且持有食品经营许可证",
      "代理多个零食品牌（说明有铺货能力）",
      "在招聘「区域经理」「业务员」——在扩区域",
      "出现在糖酒会、中食展这类展会的参展商名录里",
    ],
    sources: ["企查查（行业 + 经营范围 + 地区 + 规模）", "食品招商平台（6888 等）", "糖酒会 / 中食展名录", "各地食品批发市场"],
    firstTouch: "电话 → 企微",
    disqualifiers: ["只有餐饮堂食，没有零售渠道", "纯种植合作社（是我们的上游，不是客户）"],
  },
  {
    key: "retail_chain",
    name: "零食连锁 / 商超 / 便利店采购",
    priority: "P0",
    profile: "量贩零食连锁、区域商超、便利店系统的采购与选品负责人",
    signals: [
      "门店在扩张（高德 POI 数得出来）",
      "在招「采购经理」「选品」",
      "发布招标 / 供应商招募",
      "年节档期上新坚果礼盒",
    ],
    sources: ["企查查 + 高德 POI（算门店数）", "招标网", "招聘网站", "行业展会"],
    firstTouch: "电话 → 寄样 → 展会面谈",
    disqualifiers: ["单店、无连锁体系的小卖部（走经销商更划算）"],
  },
  {
    key: "ecommerce_reseller",
    name: "电商分销商（一件代发）",
    priority: "P1",
    profile: "淘宝 / 拼多多 / 抖音小店卖家，卖坚果零食，月销 10 万以上",
    signals: ["店铺在售同类目坚果", "店铺等级与粉丝量", "直播或短视频频次高", "在 1688 找货源"],
    sources: ["抖音 / 淘宝开放平台", "蝉妈妈 / 飞瓜", "1688 分销"],
    firstTouch: "旺旺 / 企微 / 抖音私信",
    disqualifiers: ["只卖生鲜、和坚果无关的店"],
  },
  {
    key: "corporate_gifting",
    name: "企业团购 / 福利礼品",
    priority: "P1",
    profile: "HR、行政、工会采购年节礼盒；礼品公司与福利平台",
    signals: ["工会福利 / 节日慰问品招标公告", "员工规模较大", "在招行政或采购", "礼盒采购集中在节前 2 个月"],
    sources: ["中国政府采购网", "招标投标公共服务平台", "企查查规模", "礼品行业协会"],
    firstTouch: "电话 + 邮件（方案 + 报价）",
    disqualifiers: ["已经和固定供应商年框合作、当年不换"],
  },
  {
    key: "live_commerce",
    name: "直播带货 MCN / 达人",
    priority: "P2",
    profile: "食品饮料类目达人，粉丝 10 万–500 万，场均 GMV 10 万以上",
    signals: ["近 30 天带过坚果 / 零食", "带货口碑分", "坑位费与佣金区间公开"],
    sources: ["蝉妈妈 / 飞瓜达人榜", "巨量星图", "小红书蒲公英"],
    firstTouch: "商务微信 + 正式邮件",
    disqualifiers: ["纯娱乐主播、没有食品类目历史"],
  },
  {
    key: "special_channel",
    name: "特通渠道",
    priority: "P3",
    profile: "酒店、餐饮、航空配餐、母婴、药房等非传统零售渠道",
    signals: ["连锁门店数", "招标 / 供应链公司", "自有品牌代工需求"],
    sources: ["企查查", "高德 POI", "行业展会"],
    firstTouch: "电话 / 展会",
    disqualifiers: ["规模太小、起订量低于最小生产批量"],
  },
];

export const SEGMENT_BY_KEY: Readonly<Record<IcpSegmentKey, IcpSegment>> = Object.fromEntries(
  ICP_SEGMENTS.map((segment) => [segment.key, segment]),
) as Record<IcpSegmentKey, IcpSegment>;

/** 按优先级排序，P0 在前。 */
export function segmentsByPriority(): IcpSegment[] {
  const order: Record<IcpPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...ICP_SEGMENTS].sort((a, b) => order[a.priority] - order[b.priority]);
}

/**
 * 搜索关键词库：企查查 / 平台搜索直接能用。
 * 分三组是为了组合出不同查法——行业词定"是不是这行"，渠道词定"有没有卖货能力"。
 */
export const ICP_KEYWORDS = {
  industry: [
    "坚果", "炒货", "山核桃", "碧根果", "夏威夷果", "腰果", "板栗",
    "每日坚果", "休闲零食", "预包装食品", "食品批发", "食品经营", "食品供应链",
  ],
  channel: [
    "电商代运营", "直播带货", "MCN", "社区团购", "团长", "一件代发",
    "区域代理", "经销商", "加盟", "便利店", "零食连锁", "商超", "礼品", "企业福利", "团购",
  ],
  exclude: ["种植合作社", "餐饮堂食", "机械设备", "已合作客户"],
} as const;

/** 渲染成 Markdown，作为「目标客户画像」知识文档写进 CRM。 */
export function renderIcpBrief(): string {
  const lines: string[] = ["# 我们要找的客户", "", "按优先级排列。P0 先打，P1 跟上，P2/P3 有余力再碰。", ""];
  for (const segment of segmentsByPriority()) {
    lines.push(`## ${segment.priority}｜${segment.name}`, "");
    lines.push(`**画像**：${segment.profile}`, "");
    lines.push("**怎么判断**：", ...segment.signals.map((signal) => `- ${signal}`), "");
    lines.push("**去哪儿找**：", ...segment.sources.map((source) => `- ${source}`), "");
    lines.push(`**首触**：${segment.firstTouch}`, "");
    if (segment.disqualifiers.length) {
      lines.push("**不是这类**：", ...segment.disqualifiers.map((item) => `- ${item}`), "");
    }
  }
  lines.push("## 搜索关键词", "");
  lines.push(`- 行业：${ICP_KEYWORDS.industry.join("、")}`);
  lines.push(`- 渠道：${ICP_KEYWORDS.channel.join("、")}`);
  lines.push(`- 排除：${ICP_KEYWORDS.exclude.join("、")}`);
  // trim：知识库那边存的是 trim 过的文本，这里也对齐，否则每次 seed 都会被判成"变了"。
  return lines.join("\n").trim();
}
