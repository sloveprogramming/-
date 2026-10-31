/**
 * 草稿审校：在草稿落库前检查它有没有踩商业红线。
 *
 * ## 为什么这一步用规则，不用模型
 *
 * 红线是**明确的清单**（见 `lib/icp/profile.ts` 的 neverPromise）：不报价、不承诺
 * 独家、不谈账期、不编检测报告。清单越明确，规则就越该赢——模型会漏，正则不会；
 * 而且规则零成本、毫秒级、结果可复现，销售问"为什么判我违规"能直接指出是哪几个字。
 *
 * 语义等价的绕法（"给您留个最优惠的价"）规则抓不住，那才是模型该上的地方。
 * 这里刻意先只做确定性能覆盖的部分，**宁可漏报也不要误报**：误报多了，
 * 销售就不看提示了，等于白做。
 *
 * ## block 与 warn 的区别
 *
 * - `block`：说了具体商业条款（金额、折扣、账期、独家授权、周期数字、认证结论）。
 *   这类内容发出去就是事故——销售兑现不了，客户拿着聊天记录来要。
 * - `warn`：绝对化措辞、提了报告名但没编内容。可能没问题，但人该看一眼。
 *
 * 只有出现 `block` 级命中时 verdict 才是 `block`，此时**草稿不允许自动发送**。
 */
import type { CrmChannel } from "../schema";

export type ReviewSeverity = "block" | "warn";

export type ReviewViolation = {
  /** 规则 id，与 neverPromise 的条目对应，便于统计"最常踩哪条"。 */
  rule: string;
  /** 人话标签，直接展示给销售。 */
  label: string;
  severity: ReviewSeverity;
  /** 命中的原文片段（前后各带几个字），便于人核对。 */
  quote: string | null;
  /** 建议怎么改。 */
  suggestion: string;
};

export type DraftReview = {
  /** block = 有硬红线，不能自动发；pass = 最多只有提醒。 */
  verdict: "pass" | "block";
  violations: ReviewViolation[];
  /** 跑了多少条规则——用来解释"为什么没查出来"，而不是让人以为没查。 */
  checkedRules: number;
};

type ReviewRule = {
  id: string;
  label: string;
  severity: ReviewSeverity;
  pattern: RegExp;
  suggestion: string;
};

/**
 * 规则表。
 *
 * 正则有两条自我约束：
 * 1. **不带 `g` 标志**——避免 `lastIndex` 状态在多次调用间串味，这里只需要
 *    知道"有没有命中、命中在哪"。
 * 2. **要求出现具体内容，而不是出现某个词**。"报价单"可以说（话术模板里就有），
 *    "报价 120 元"不可以说。所以匹配的是「词 + 数字」的组合，不是词本身。
 */
const RULES: readonly ReviewRule[] = [
  {
    id: "price",
    label: "报了具体价格",
    severity: "block",
    // 出现金额：120 元 / 12.5 元/箱 / 每箱 120 元
    pattern: /\d+(?:\.\d+)?\s*元(?:\s*\/\s*(?:箱|袋|件|盒|斤|公斤|kg))?|每\s*(?:箱|袋|件|盒|斤|公斤)\s*\d+(?:\.\d+)?\s*元/i,
    suggestion: "删掉金额，改成「发您一份报价单」——具体价格必须走书面确认。",
  },
  {
    id: "quote_number",
    label: "报价给了具体数字",
    severity: "block",
    pattern: /(?:报价|价格|单价|出厂价|供货价)\s*(?:是|为|大概|大约|[:：])\s*\d/i,
    suggestion: "不报数字。可以说明价格区间需要按量确认，或先问对方要多少量。",
  },
  {
    id: "discount",
    label: "承诺了折扣或返点",
    severity: "block",
    pattern: /返点|返利|扣点|返佣|打\s*\d+(?:\.\d+)?\s*折|\d+(?:\.\d+)?\s*折|折扣\s*(?:是|为|到|[:：])?\s*\d/,
    suggestion: "折扣/返点属于政策条款，必须由商务书面确认后才能提。",
  },
  {
    id: "payment_terms",
    label: "谈了账期或结算方式",
    severity: "block",
    pattern: /账期|月结|赊销|垫资|先货后款|货到付款/,
    suggestion: "账期是财务条款，销售无权在聊天里确认。改成「结算方式我请财务跟您对接」。",
  },
  {
    id: "exclusive_grant",
    label: "承诺了独家授权",
    severity: "block",
    pattern: /独家(?:授权|代理权)?\s*(?:给|归)|只(?:给|授权给|放给)\s*(?:您|你)|(?:您|你)\s*(?:是|做|拿)\s*(?:我们)?的?\s*独家/,
    suggestion: "「区域独家」是招商政策，可以说；「这个区域只给您」是承诺，不能说。改成「独家政策我发您细则」。",
  },
  {
    id: "lead_time",
    label: "承诺了供货周期或产能",
    severity: "block",
    pattern: /\d+\s*(?:个)?(?:工作)?\s*天(?:内)?\s*(?:发货|到货|交货|送达|出库)|产能|日产|月产|供货周期/i,
    suggestion: "交期与产能受排产影响，不能口头承诺。改成「确认库存后排产，签约后给你排期表」。",
  },
  {
    id: "certification_claim",
    label: "编了认证或检测结论",
    severity: "block",
    pattern: /符合(?:国家)?标准|达到.{0,8}标准|无添加|零添加|纯天然|有机认证|零蔗糖|不含防腐剂/,
    suggestion: "检测报告的**结论**不能由销售口述。改成「检测报告随报价单一并附上」。",
  },
  {
    id: "exclusive_mention",
    label: "提到独家（政策可提，需确认口径）",
    severity: "warn",
    pattern: /独家|区域保护|唯一代理|总代理/,
    suggestion: "提政策可以，但只说「有区域独家政策」，不要描述具体范围与条件。",
  },
  {
    id: "certification_mention",
    label: "提到检测报告或认证",
    severity: "warn",
    pattern: /检测报告|质检报告|SGS|第三方检测|认证证书|资质证书/i,
    suggestion: "可以说「附检测报告」，但不能描述报告内容。确认报告是最新版本再发。",
  },
  {
    id: "absolute_claim",
    label: "绝对化措辞",
    severity: "warn",
    pattern: /保证|承诺|绝对|100%|百分百|无条件|一定(?:能|会|可以)/,
    suggestion: "中文商务少用绝对化表达，改成「尽量」「一般情况」更稳妥，也不容易被抓话。",
  },
  {
    id: "exclamation",
    label: "感叹号过多",
    severity: "warn",
    pattern: /！[^！]{0,20}！/,
    suggestion: "一句里多个感叹号像群发广告，删到最多一个或不留。",
  },
];

/** 短信按 70 字一条计费，超了会拆条。这是个成本规则，不是文风规则。 */
const SMS_LIMIT = 70;

/**
 * 审一条草稿。
 *
 * 纯函数：同样的输入永远得到同样的输出，不碰网络、不碰数据库。
 * 所以它能进单测、能在客户端预校验、也能在事后回放历史草稿。
 */
export function reviewDraft(input: {
  bodyText: string;
  subject?: string | null;
  channel: CrmChannel;
}): DraftReview {
  const text = input.bodyText ?? "";
  const violations: ReviewViolation[] = [];

  for (const rule of RULES) {
    // subject 与正文一起查：邮件主题里写"报价 120 元"一样是事故。
    const haystacks = [text, input.subject ?? ""];
    for (const haystack of haystacks) {
      const match = haystack.match(rule.pattern);
      if (!match || match.index == null) continue;
      violations.push({
        rule: rule.id,
        label: rule.label,
        severity: rule.severity,
        quote: excerptAt(haystack, match.index, match[0].length),
        suggestion: rule.suggestion,
      });
      break;
    }
  }

  if (input.channel === "sms" && text.length > SMS_LIMIT) {
    violations.push({
      rule: "sms_length",
      label: `短信超过 ${SMS_LIMIT} 字（${text.length} 字）`,
      severity: "warn",
      quote: null,
      suggestion: `删到 ${SMS_LIMIT} 字以内，否则会拆成多条、按条计费。`,
    });
  }

  return {
    verdict: violations.some((item) => item.severity === "block") ? "block" : "pass",
    violations,
    checkedRules: RULES.length + 1,
  };
}

/** 取命中位置附近的一段原文，两边各留 8 个字，便于人核对。 */
function excerptAt(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 8);
  const end = Math.min(text.length, index + length + 8);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/** 只取硬红线，便于"必须改"和"最好改"分开展示。 */
export function blockingViolations(review: DraftReview): ReviewViolation[] {
  return review.violations.filter((item) => item.severity === "block");
}

/** 一句话摘要，给日志与事件 meta 用。 */
export function summarizeReview(review: DraftReview): string {
  if (!review.violations.length) return "未发现红线";
  const blocking = blockingViolations(review).length;
  const warnings = review.violations.length - blocking;
  return [
    blocking ? `${blocking} 项必须改` : null,
    warnings ? `${warnings} 项提醒` : null,
  ].filter(Boolean).join("、");
}
