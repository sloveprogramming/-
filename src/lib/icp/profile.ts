/**
 * 新农哥的业务事实。
 *
 * 这个文件是「垂类聚焦」的地基：AI 起草时会把这些事实作为知识库喂进去，
 * 销售看到的客户画像、评分口径、首触话术也都从这里派生。改动它等于改口径，
 * 所以每条都注明来源与不确定性。
 *
 * 来源：公开招商资料（火爆食品网 6888.tv 的新农哥招商页）与公司公开介绍。
 * 标注 `confirm: true` 的条目是我们没拿到一手确认、需要公司核对的——宁可标出来，
 * 也不要让 AI 把这些当成铁的事实写进给客户的消息里。
 */

export type ProductLine = {
  name: string;
  /** 一句话卖点，销售会直接说给客户听。 */
  pitch: string;
};

export type CompanyProfile = {
  name: string;
  shortName: string;
  founded: number;
  /** 工厂 / 产地所在地。 */
  origin: string;
  positioning: string;
  products: readonly ProductLine[];
  /** 合作方式：决定了我们在跟哪一类客户谈。 */
  policies: readonly { key: string; label: string; detail: string; confirm?: boolean }[];
  /** 对代理商的要求（来自公开招商条件）。 */
  partnerRequirements: readonly string[];
  /** 可信的事实型背书。 */
  proofPoints: readonly string[];
  /** 绝对不能对客户承诺的（AI 起草必须避开）。 */
  neverPromise: readonly string[];
};

export const XINNONGGE: CompanyProfile = {
  name: "杭州新农哥食品科技有限公司",
  shortName: "新农哥",
  founded: 2006,
  origin: "浙江杭州临安（中国坚果炒货之都）",
  positioning: "坚果炒货品牌 + 自有生产能力的厂家",
  products: [
    { name: "临安山核桃 / 山核桃仁", pitch: "产地直采，手剥与仁装两条线，年节礼盒的主力单品" },
    { name: "每日坚果", pitch: "混合装，小包装，适合商超端架与办公室场景" },
    { name: "夏威夷果（芥末味 / 咸蛋黄味）", pitch: "风味坚果，年轻客群复购好" },
    { name: "碧根果 / 腰果 / 开心果", pitch: "常销基础款，价格带覆盖广，适合做引流" },
    { name: "板栗仁（含冰冰栗）", pitch: "即食型，秋冬旺季走量" },
    { name: "中秋 / 年货礼盒", pitch: "企业福利、团购、商超年节档期" },
  ],
  policies: [
    {
      key: "regional_exclusive",
      label: "区域独家代理",
      detail: "按区域授权，一个区域只设一家代理商，配首批进货搭赠、广宣物料、业务员驻场支持",
    },
    {
      key: "dropship",
      label: "一件代发",
      detail: "电商卖家不用压货，下单后由工厂直发，适合淘宝/拼多多/抖音小店",
    },
    {
      key: "wholesale",
      label: "批发供货",
      detail: "按箱起订，适合流通批发商、零食连锁与商超配送商",
    },
    {
      key: "oem",
      label: "代工 / OEM",
      detail: "自有生产线可接代工",
      confirm: true,
    },
  ],
  partnerRequirements: [
    "有正式工商注册的公司或个体商户",
    "有休闲食品的分销网络或门店资源",
    "有配送能力",
    "有过相近品类的代理经验优先",
  ],
  proofPoints: [
    "2006 年成立于临安，做坚果炒货近 20 年",
    "自建研发与机械技术团队，参与生产环节",
    "公开资料称累计服务数百万会员",
    "产品线覆盖山核桃、每日坚果、风味坚果、礼盒四个方向",
  ],
  neverPromise: [
    "没有书面确认的价格、折扣、返点",
    "未经授权的独家区域与代理政策细节",
    "具体的供货周期与产能数字",
    "任何检测报告、认证的具体内容",
  ],
};

/** 渲染成 Markdown，作为「公司简介」知识文档写进 CRM（alwaysInclude）。 */
export function renderCompanyBrief(): string {
  const lines: string[] = [
    `# ${XINNONGGE.shortName}是谁`,
    "",
    `${XINNONGGE.name}，${XINNONGGE.founded} 年成立于${XINNONGGE.origin}，是${XINNONGGE.positioning}。`,
    "",
    "## 我们卖什么",
    "",
    ...XINNONGGE.products.map((product) => `- **${product.name}**：${product.pitch}`),
    "",
    "## 我们怎么合作",
    "",
    ...XINNONGGE.policies.map((policy) => `- **${policy.label}**：${policy.detail}`),
    "",
    "## 我们对合作方的基本要求",
    "",
    ...XINNONGGE.partnerRequirements.map((requirement) => `- ${requirement}`),
    "",
    "## 可以说的事实",
    "",
    ...XINNONGGE.proofPoints.map((point) => `- ${point}`),
    "",
    "## 绝对不要承诺的（写进任何消息前先看这条）",
    "",
    ...XINNONGGE.neverPromise.map((item) => `- ${item}`),
    "",
    "> 价格、返点、独家区域这些，一律回「我让负责这块的同事给您一份正式报价」，不要在聊天里给数字。",
  ];
  // trim：知识库那边存的是 trim 过的文本，这里也对齐，否则每次 seed 都会被判成"变了"。
  return lines.join("\n").trim();
}
