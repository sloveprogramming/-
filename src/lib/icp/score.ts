/**
 * 线索评分：把「像不像新农哥的客户」变成一个 0-100 的分数。
 *
 * 原来的资格判定很简单粗暴——这家公司在 Apollo 里有没有 3 个以上可验证邮箱。
 * 国内没有那种人员库，所以换成四个维度的加权打分，每个维度都对应一个销售
 * 实际会问的问题：
 *
 *   企业资质 30  他是这行的公司吗？靠谱吗？
 *   渠道能力 30  他卖得动货吗？有多少门店铺货？
 *   需求信号 25  他最近是不是正好要进货？
 *   触达可达性 15 我联系得上决策人吗？
 *
 * 分数不是目的：A 级（≥70）进人工优先跟进，B 级（50-69）批量触达，C 级（<50）
 * 进培育池不打扰。同时输出「还缺什么」，销售知道下一步该去查什么。
 *
 * 纯函数，可在浏览器和测试里直接跑。
 */

export type Scale = "micro" | "small" | "mid" | "large";

export type LeadSignals = {
  /** 经营范围 / 行业命中食品、坚果、炒货。 */
  industryMatch?: boolean | null;
  /** 持有食品经营许可证。 */
  foodLicense?: boolean | null;
  /** 成立年数。 */
  registeredYears?: number | null;
  /** 规模：按参保人数或营收粗分。 */
  scale?: Scale | null;

  /** 线下门店数（高德 POI 可数）。 */
  storeCount?: number | null;
  /** 有电商店铺（淘宝/拼多多/抖音小店/1688）。 */
  hasOnlineStore?: boolean | null;
  /** 在卖坚果或同类零食。 */
  distributesSnacks?: boolean | null;
  /** 有分销网络 / 配送能力（经销商特征）。 */
  distributionNetwork?: boolean | null;

  /** 最近在招渠道、采购、电商运营岗。 */
  hiringChannelRole?: boolean | null;
  /** 近期有招标或中标公告（福利采购 / 供应商招募）。 */
  recentTender?: boolean | null;
  /** 新上了坚果品类，或在扩品类。 */
  newSnackCategory?: boolean | null;
  /** 近一年参加行业展会。 */
  attendedTradeShow?: boolean | null;

  /** 能拿到手机号。 */
  hasMobile?: boolean | null;
  /** 能加到/已加企业微信。 */
  hasWecom?: boolean | null;
  /** 已经定位到决策人（老板 / 采购负责人）。 */
  decisionMakerIdentified?: boolean | null;
};

export type ScoreGrade = "A" | "B" | "C";

export type ScoreDimension = { key: string; label: string; score: number; max: number };

export type ScoreResult = {
  score: number;
  grade: ScoreGrade;
  dimensions: ScoreDimension[];
  /** 命中了什么、缺了什么，人话。 */
  reasons: string[];
  /** 还该去查什么——没有满分的维度各给一条建议。 */
  nextChecks: string[];
};

/** 各信号的权重。集中在这里，改口径只改这张表。 */
const WEIGHTS = {
  industryMatch: 10,
  foodLicense: 8,
  registeredYears: 6,
  scale: 6,
  storeCount: 10,
  hasOnlineStore: 8,
  distributesSnacks: 7,
  distributionNetwork: 5,
  hiringChannelRole: 8,
  recentTender: 7,
  newSnackCategory: 6,
  attendedTradeShow: 4,
  hasMobile: 8,
  hasWecom: 4,
  decisionMakerIdentified: 3,
} as const;

const SCALE_SCORE: Record<Scale, number> = { micro: 1, small: 3, mid: 5, large: 6 };

/** 成立年数 → 得分：3 年以下 0，3-5 年半分，5 年以上满分。 */
function yearsScore(years: number | null | undefined): number {
  if (years == null || !Number.isFinite(years)) return 0;
  if (years >= 5) return WEIGHTS.registeredYears;
  if (years >= 3) return 3;
  return 0;
}

/** 门店数 → 得分：≥50 满分，≥10 七分，≥3 四分，1-2 两分。 */
function storeScore(count: number | null | undefined): number {
  if (count == null || !Number.isFinite(count)) return 0;
  if (count >= 50) return WEIGHTS.storeCount;
  if (count >= 10) return 7;
  if (count >= 3) return 4;
  if (count >= 1) return 2;
  return 0;
}

const yes = (value: boolean | null | undefined, points: number): number => (value === true ? points : 0);

export function scoreLead(signals: LeadSignals): ScoreResult {
  const qualification =
    yes(signals.industryMatch, WEIGHTS.industryMatch) +
    yes(signals.foodLicense, WEIGHTS.foodLicense) +
    yearsScore(signals.registeredYears) +
    (signals.scale ? SCALE_SCORE[signals.scale] : 0);

  const channel =
    storeScore(signals.storeCount) +
    yes(signals.hasOnlineStore, WEIGHTS.hasOnlineStore) +
    yes(signals.distributesSnacks, WEIGHTS.distributesSnacks) +
    yes(signals.distributionNetwork, WEIGHTS.distributionNetwork);

  const demand =
    yes(signals.hiringChannelRole, WEIGHTS.hiringChannelRole) +
    yes(signals.recentTender, WEIGHTS.recentTender) +
    yes(signals.newSnackCategory, WEIGHTS.newSnackCategory) +
    yes(signals.attendedTradeShow, WEIGHTS.attendedTradeShow);

  const reachability =
    yes(signals.hasMobile, WEIGHTS.hasMobile) +
    yes(signals.hasWecom, WEIGHTS.hasWecom) +
    yes(signals.decisionMakerIdentified, WEIGHTS.decisionMakerIdentified);

  const dimensions: ScoreDimension[] = [
    { key: "qualification", label: "企业资质", score: qualification, max: 30 },
    { key: "channel", label: "渠道能力", score: channel, max: 30 },
    { key: "demand", label: "需求信号", score: demand, max: 25 },
    { key: "reachability", label: "触达可达性", score: reachability, max: 15 },
  ];

  const score = qualification + channel + demand + reachability;
  const grade: ScoreGrade = score >= 70 ? "A" : score >= 50 ? "B" : "C";

  const reasons: string[] = [];
  const nextChecks: string[] = [];

  if (signals.industryMatch === true) reasons.push("经营范围命中食品/坚果");
  else if (signals.industryMatch === false) reasons.push("行业不匹配，先确认这家公司到底做什么");
  if (signals.foodLicense === true) reasons.push("有食品经营许可证");
  if (signals.distributesSnacks === true) reasons.push("在卖坚果或同类零食");
  if (signals.storeCount != null && signals.storeCount > 0) reasons.push(`线下门店约 ${signals.storeCount} 家`);
  if (signals.hasOnlineStore === true) reasons.push("有电商店铺");
  if (signals.hiringChannelRole === true) reasons.push("在招渠道/采购岗，可能在扩张");
  if (signals.recentTender === true) reasons.push("近期有招标或中标");
  if (signals.hasMobile === true) reasons.push("有手机号可直接联系");
  if (signals.decisionMakerIdentified === true) reasons.push("已定位到决策人");

  // 提示要具体到"缺哪一项"，不能把已经拿到的信号也列进去。举个例子：明明命中
  // 了"在招渠道岗"，还提示"找需求信号：最近有没有招人"，销售会立刻不信任这张表。
  const missingQualification: string[] = [];
  if (signals.industryMatch !== true) missingQualification.push("经营范围是否含食品");
  if (signals.foodLicense !== true) missingQualification.push("食品经营许可证");
  if (yearsScore(signals.registeredYears) < WEIGHTS.registeredYears) missingQualification.push("成立年限");
  if (!signals.scale) missingQualification.push("公司规模");

  const missingChannel: string[] = [];
  if (storeScore(signals.storeCount) < WEIGHTS.storeCount) missingChannel.push("门店数");
  if (signals.hasOnlineStore !== true) missingChannel.push("有没有电商店");
  if (signals.distributesSnacks !== true) missingChannel.push("在卖什么品类");
  if (signals.distributionNetwork !== true) missingChannel.push("分销与配送能力");

  const missingDemand: string[] = [];
  if (signals.hiringChannelRole !== true) missingDemand.push("招渠道/采购岗");
  if (signals.recentTender !== true) missingDemand.push("招标或中标");
  if (signals.newSnackCategory !== true) missingDemand.push("上新坚果品类");
  if (signals.attendedTradeShow !== true) missingDemand.push("参展记录");

  const missingReach: string[] = [];
  if (signals.hasMobile !== true) missingReach.push("手机号");
  if (signals.hasWecom !== true) missingReach.push("企业微信");
  if (signals.decisionMakerIdentified !== true) missingReach.push("决策人是谁");

  // 只在维度明显不完整时才提示去补（低于 80%），否则"资质 29/30"也会被要求去补。
  if (qualification < 24 && missingQualification.length) {
    nextChecks.push(`补企业底细：${missingQualification.join("、")}`);
  }
  if (channel < 24 && missingChannel.length) {
    nextChecks.push(`补渠道情况：${missingChannel.join("、")}`);
  }
  if (demand < 20 && missingDemand.length) {
    nextChecks.push(`找需求信号：${missingDemand.join("、")}`);
  }
  if (reachability < 12 && missingReach.length) {
    nextChecks.push(`补联系方式：${missingReach.join("、")}`);
  }

  return { score, grade, dimensions, reasons, nextChecks };
}

/** A/B/C 的中文说法，UI 直接用。 */
export const GRADE_LABEL: Record<ScoreGrade, string> = {
  A: "A 级 · 优先跟进",
  B: "B 级 · 批量触达",
  C: "C 级 · 培育池",
};
