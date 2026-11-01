import type { ProductIntent } from "@/lib/icp/productIntent";
import type { ProspectResult } from "./types";

/** 从产品画像里取买家行业词，用于判断企业行业是否匹配。产品词本身不算。 */
export function buyerTermsFor(intent: ProductIntent): string[] {
  const product = intent.query.toLowerCase();
  return intent.searchTerms.filter((term) => term.trim() && term.toLowerCase() !== product);
}

/**
 * 清洗电话：去重、去掉明显不是电话的内容。
 *
 * 企查查的电话字段可能是逗号分隔的多个号码、带分机、或者混进手机号。
 * 这里只做保守的规范化，不判断号码真假。
 */
export function cleanPhones(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    for (const piece of entry.split(/[,，;；/、\s]+/)) {
      const phone = piece.replace(/[^\d-]/g, "").trim();
      const digits = phone.replace(/-/g, "");
      if (digits.length < 7 || digits.length > 13) continue;
      if (seen.has(digits)) continue;
      seen.add(digits);
      out.push(phone);
    }
  }
  return out;
}

/** 把结果渲染成一句话摘要，给界面和日志用。 */
export function summarizeResult(result: ProspectResult): string {
  const { stats, intent } = result;
  if (!stats.found) return `「${result.product}」没有搜到公司`;
  return [
    `「${result.product}」`,
    intent.category ? `判定为${intent.category}` : "未识别品类",
    `搜 ${stats.searchedTerms} 个词得 ${stats.found} 家`,
    `其中 ${stats.reachable} 家有电话`,
    `${stats.priority} 家建议优先联系`,
  ].join("，");
}
