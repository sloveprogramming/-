import "server-only";

import { z } from "zod";
import { callQccTool, qccMcpConfigured } from "@/lib/qcc/mcp/client";
import type { ToolRegistry } from "../tools";

/**
 * 企查查 MCP 工具集：让资格员在"这家公司到底值不值得打"这件事上能查真实数据。
 *
 * ## 为什么这些工具会真的改变判断
 *
 * 原来的打分只看工商登记：注册资本、成立年限、行业、状态、经营范围。这些是
 * **静态资质**，回答"这家公司像不像客户"，但回答不了"他现在是不是正好要进货"。
 *
 * 有了 MCP，两类信号能拿到：
 * - `lookup_recruitment` —— 在招采购/渠道/销售 = 有扩张意图（需求信号）
 * - `lookup_bidding`     —— 中标 / 招标 = 有实际业务在跑（需求信号）
 * - `lookup_qualifications` —— 食品经营许可、流通许可 = 真能铺货（渠道能力）
 * - `lookup_food_safety` —— 食品安全处罚 = 坚果行业的硬风险
 *
 * ## 为什么工具层要做"信号提取"
 *
 * 企查查返回的是原始记录：某家公司的招聘信息有 891 条，全塞进上下文会直接
 * 撑爆窗口，而且模型还要自己从 30 条招聘里找"有没有招采购"——这件事用关键词
 * 过滤一次就能做完。
 *
 * 所以工具返回的是**样本 + 摘要 + 命中标记**，不是全量数据。模型拿到的是
 * "看到 30 条里的 8 条，其中 2 条是渠道岗"，足够判断，也省 token。
 *
 * ## 参数纪律
 *
 * 所有工具只收 `companyName`（必须是**完整登记名**或 18 位信用代码）。企查查
 * 的实体锚定规则很严：传简称会被直接拒。这里不替调用方猜或补全名字——查不到
 * 就把上游的原话带回去，让人或模型决定下一步。
 */

/**
 * 这些职位名说明"他在招能卖货的人"，是需求信号里最直接的一种。
 *
 * 中英文都要收：实测遇到过「Sales Development Representative」这种英文岗位名，
 * 只匹配中文会漏掉——而外企、跨境团队的招聘恰恰常用英文。
 */
const CHANNEL_JOB_KEYWORDS = [
  "采购",
  "渠道",
  "销售",
  "商务",
  "招商",
  "经销",
  "大客户",
  "sales",
  "business development",
  "channel",
  "purchas",
  "sourcing",
  "account executive",
];

/** 一次最多回几条样本。够判断就行，多了是烧上下文。 */
const SAMPLE_LIMIT = 8;

function notConfigured() {
  return {
    error: "企查查 MCP 未配置（缺少 QCC_MCP_TOKEN），无法查这些信号。",
    hint: "换用工商登记信息判断，并在结论里注明「未查经营信号」。",
  };
}

/**
 * 在未知结构的返回里找第一个非空数组。
 *
 * 企查查各工具的字段名不完全统一（`招聘信息` / `招标信息` / `资质证书`…），
 * 与其逐个猜字段名，不如按"第一个数组"取——它对新增工具也有韧性。
 */
export function firstArray(data: unknown): { key: string; rows: unknown[] } | null {
  if (!data || typeof data !== "object") return null;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (Array.isArray(value) && value.length) return { key, rows: value };
  }
  return null;
}

/** 从一条记录里挑几个可能有用的短字段，压掉长文本。 */
function shrinkRow(row: unknown, fields: readonly string[], textLimit = 60): Record<string, string> {
  const out: Record<string, string> = {};
  if (!row || typeof row !== "object") return out;
  const record = row as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) {
      out[field] = value.trim().slice(0, textLimit);
    } else if (typeof value === "number") {
      out[field] = String(value);
    } else if (Array.isArray(value) && value.length) {
      // 招投标里的「招采单位」「中标单位」是数组，直接丢就白查了。
      out[field] = value
        .filter((item): item is string => typeof item === "string")
        .join(" / ")
        .slice(0, textLimit);
    }
  }
  // 字段名对不上时至少留个原文，避免返回空对象让模型以为"查不到"。
  if (!Object.keys(out).length) {
    out.值 = JSON.stringify(row).slice(0, 200);
  }
  return out;
}

/** 摘要字段：企查查会带一句人话，优先用它。 */
function summaryOf(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  for (const key of ["摘要", "提示", "说明"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function companyNameSchema() {
  return z
    .string()
    .min(4)
    .max(120)
    .describe("完整企业登记名（含「有限公司」等后缀）或 18 位统一社会信用代码。简称会被拒。");
}

export function registerQccSignalTools(registry: ToolRegistry): ToolRegistry {
  return registry
    .register({
      name: "lookup_company_profile",
      description:
        "查企业的行业分类（四级）、企业规模、主营产品、简介。用来确认「他到底是哪一行的、多大体量」，比只看经营范围准。",
      risk: "read",
      timeoutMs: 30_000,
      schema: z.object({ companyName: companyNameSchema() }),
      execute: async ({ companyName }) => {
        if (!qccMcpConfigured()) return notConfigured();
        const result = await callQccTool({
          domain: "company",
          tool: "get_company_profile",
          args: { searchKey: companyName },
        });
        if (!result.ok) return { error: result.error };
        const data = result.data as Record<string, unknown> | null;
        const industry = data?.["企查查行业"];
        return {
          企业名称: data?.["企业名称"] ?? companyName,
          行业: industry && typeof industry === "object"
            ? Object.values(industry as Record<string, unknown>).filter((v) => typeof v === "string").join(" / ")
            : null,
          规模: data?.["企业规模"] ?? null,
          主营产品: Array.isArray(data?.["主营产品"]) ? (data["主营产品"] as unknown[]).slice(0, 10) : [],
          简介: typeof data?.["简介"] === "string" ? (data["简介"] as string).slice(0, 300) : null,
        };
      },
    })
    .register({
      name: "lookup_recruitment",
      description:
        "查这家公司最近在招什么岗位。在招「采购/渠道/销售/商务」说明他正在扩张渠道，是最直接的需求信号。",
      risk: "read",
      timeoutMs: 30_000,
      schema: z.object({
        companyName: companyNameSchema(),
        dateFrom: z.string().optional().describe("起始日期，格式 YYYY-MM-DD；不填取最新"),
      }),
      execute: async ({ companyName, dateFrom }) => {
        if (!qccMcpConfigured()) return notConfigured();
        const result = await callQccTool({
          domain: "operation",
          tool: "get_recruitment_info",
          args: { searchKey: companyName, ...(dateFrom ? { date_from: dateFrom } : {}) },
        });
        if (!result.ok) return { error: result.error };
        const found = firstArray(result.data);
        const rows = found?.rows ?? [];
        const samples = rows.slice(0, SAMPLE_LIMIT).map((row) => shrinkRow(row, ["招聘职位", "办公地点", "月薪", "发布日期"]));
        // 关键判断交给这里做一次：30 条里找"采购岗"用关键词比用模型快得多。
        const channelHits = samples.filter((row) => {
          // 大小写不敏感：英文岗位名常见 "Sales" / "SALES" 混写。
          const title = String(row.招聘职位 ?? "").toLowerCase();
          return CHANNEL_JOB_KEYWORDS.some((keyword) => title.includes(keyword.toLowerCase()));
        });
        return {
          摘要: summaryOf(result.data),
          记录数: rows.length,
          在招渠道相关岗位: channelHits.length > 0,
          渠道岗位样本: channelHits.map((row) => row.招聘职位),
          岗位样本: samples,
        };
      },
    })
    .register({
      name: "lookup_bidding",
      description:
        "查这家公司的招投标与中标记录。有中标说明业务在真实运转，也能看出他的客户是政府/企业还是零售。",
      risk: "read",
      timeoutMs: 30_000,
      schema: z.object({ companyName: companyNameSchema() }),
      execute: async ({ companyName }) => {
        if (!qccMcpConfigured()) return notConfigured();
        const result = await callQccTool({
          domain: "operation",
          tool: "get_bidding_info",
          args: { searchKey: companyName },
        });
        if (!result.ok) return { error: result.error };
        const found = firstArray(result.data);
        const rows = found?.rows ?? [];
        return {
          摘要: summaryOf(result.data),
          记录数: rows.length,
          样本: rows.slice(0, SAMPLE_LIMIT).map((row) =>
            // 实测字段名：项目名称 / 招采单位 / 中标单位 / 中标金额（不是「标题」）。
            shrinkRow(row, ["项目名称", "招采单位", "中标单位", "中标金额", "发布日期"], 80),
          ),
        };
      },
    })
    .register({
      name: "lookup_qualifications",
      description:
        "查这家公司的资质证书与行政许可（食品经营许可、食品流通许可等）。做食品分销没有这些资质，铺货能力就是空的。",
      risk: "read",
      timeoutMs: 30_000,
      schema: z.object({ companyName: companyNameSchema() }),
      execute: async ({ companyName }) => {
        if (!qccMcpConfigured()) return notConfigured();
        const result = await callQccTool({
          domain: "operation",
          tool: "get_qualifications",
          args: { searchKey: companyName },
        });
        if (!result.ok) return { error: result.error };
        const found = firstArray(result.data);
        const rows = found?.rows ?? [];
        const names = rows
          .slice(0, 15)
          .map((row) => shrinkRow(row, ["资质名称", "证书名称", "证书类型", "许可内容", "有效期至"], 50))
          .map((row) => row.资质名称 ?? row.证书名称 ?? row.证书类型 ?? row.许可内容 ?? "")
          .filter(Boolean);
        // 实测：企查查在顶层直接给了各类资质的条目数（如「食品经营许可证条目数」）。
        // 计数比从证书名里找关键词准——证书名写法不统一，计数是确定的。
        const record = (result.data ?? {}) as Record<string, unknown>;
        const foodLicenseCount = Object.keys(record)
          .filter((key) => key.endsWith("条目数") && key.includes("食品"))
          .reduce((sum, key) => sum + (Number(record[key]) || 0), 0);
        return {
          摘要: summaryOf(result.data),
          记录数: rows.length,
          食品许可条目数: foodLicenseCount,
          有食品相关资质: foodLicenseCount > 0 || names.some((name) => name.includes("食品")),
          资质名称: names.slice(0, 10),
        };
      },
    })
    .register({
      name: "lookup_food_safety",
      description:
        "查这家公司的食品安全相关记录（抽检、处罚）。坚果炒货行业里这是硬风险，有处罚记录的要谨慎合作。",
      risk: "read",
      timeoutMs: 30_000,
      schema: z.object({ companyName: companyNameSchema() }),
      execute: async ({ companyName }) => {
        if (!qccMcpConfigured()) return notConfigured();
        const result = await callQccTool({
          domain: "operation",
          tool: "get_food_safety",
          args: { searchKey: companyName },
        });
        if (!result.ok) return { error: result.error };
        const found = firstArray(result.data);
        const rows = found?.rows ?? [];
        // 实测：没有记录时这个接口**不返回数组**，只给一句「搜索结果」文本
        // （"已全量扫描该主体食品安全数据库，未发现任何记录"）。那句话本身就是
        // 结论，丢掉它等于什么都没查到——所以这里单独取出来。
        const record = (result.data ?? {}) as Record<string, unknown>;
        const conclusion = typeof record["搜索结果"] === "string" ? String(record["搜索结果"]) : null;
        return {
          结论: conclusion ?? summaryOf(result.data),
          记录数: rows.length,
          有记录: rows.length > 0,
          样本: rows.slice(0, SAMPLE_LIMIT).map((row) =>
            shrinkRow(row, ["标题", "抽检结果", "处罚结果", "公布日期", "发布日期"], 80),
          ),
        };
      },
    });
}
