import "server-only";

import { createHash } from "node:crypto";
import type { CompanyHit } from "./types";

/**
 * 企查查开放平台的搜索客户端。
 *
 * 配置：环境变量 QCC_APP_KEY / QCC_SECRET_KEY（企业账号在开放平台申请）。
 * 没配置时 `qccConfigured()` 返回 false，上层自动退回本地搜索。
 *
 * 签名：公开文档的做法是
 *   Token = MD5(key + timestamp + secret).toUpperCase()
 * 请求带 key、timestamp 参数，Token 放请求头。时间戳精确到秒，与服务器时间偏差
 * 过大会被拒（错误码 201/202 一类），所以报错里会把我们用的时间戳带回去。
 *
 * ⚠️ 这个适配器**还没有用真实账号验证过**（手上没有 key）。字段映射做成了容错的
 * （接受几种常见的键名写法），调用失败时把原始错误原样抛出，方便对照官方文档校准。
 * 不会静默返回空列表——那会让"搜不到"和"没接通"看起来一样。
 */

const QCC_BASE = process.env.QCC_BASE_URL?.trim() || "https://api.qichacha.com";

export function qccConfigured(): boolean {
  return Boolean(process.env.QCC_APP_KEY?.trim() && process.env.QCC_SECRET_KEY?.trim());
}

/** 企查查的签名：MD5(key + timestamp + secret) 全大写。 */
export function qccToken(key: string, timestamp: string, secret: string): string {
  return createHash("md5").update(`${key}${timestamp}${secret}`).digest("hex").toUpperCase();
}

/**
 * 从各种可能的键名里取第一个非空值。
 *
 * 键名比对是**大小写与分隔符不敏感**的：企查查不同接口/版本给的是 `OperName`、
 * `operName`、`legal_person_name` 这类混写，逐个别名硬凑迟早漏一个。
 */
function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  const normalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(row)) {
    normalized.set(key.toLowerCase().replace(/[\s_\-]/g, ""), value);
  }
  for (const key of keys) {
    const value = normalized.get(key.toLowerCase().replace(/[\s_\-]/g, ""));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

const text = (value: unknown): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
  return trimmed || null;
};

/**
 * 把一行企查查结果映射成统一的 CompanyHit。
 * 导出是为了单测：字段名对不上时，这里是最先出问题的地方。
 */
export function mapQccRow(row: Record<string, unknown>): CompanyHit | null {
  const name = text(pick(row, ["Name", "name", "CompanyName", "EntName"]));
  if (!name) return null;
  const creditCode = text(pick(row, ["CreditCode", "creditCode", "CreditNo", "RegNo"]));
  const regionParts = [
    text(pick(row, ["Province", "province"])),
    text(pick(row, ["City", "city"])),
    text(pick(row, ["District", "district"])),
  ].filter(Boolean);
  const rawPhones = pick(row, ["Phone", "phone", "PhoneNumber", "Tel"]);
  const phones = Array.isArray(rawPhones)
    ? rawPhones.map((value) => text(value)).filter((value): value is string => Boolean(value))
    : String(rawPhones ?? "").split(/[;,，；]/).map((value) => value.trim()).filter(Boolean);

  return {
    key: creditCode ?? name,
    name,
    creditCode,
    region: regionParts.length ? regionParts.join(" ") : text(pick(row, ["Address", "address"])),
    industry: text(pick(row, ["Industry", "industry", "IndustryName", "Category"])),
    legalPerson: text(pick(row, ["OperName", "operName", "LegalPerson", "LegalPersonName"])),
    foundedAt: text(pick(row, ["StartDate", "startDate", "EstablishDate", "EsDate"])),
    registeredCapital: text(pick(row, ["RegistCapi", "registCapi", "RegisteredCapital", "RegCapital"])),
    phones,
    scope: text(pick(row, ["Scope", "scope", "BusinessScope", "OperScope"])),
    status: text(pick(row, ["Status", "status", "EntStatus"])),
    inLibrary: false,
  };
}

export type QccSearchOptions = { limit?: number; page?: number };

/** 搜全国企业。失败时抛错（带上游错误），由上层决定怎么提示。 */
export async function searchQcc(query: string, options: QccSearchOptions = {}): Promise<CompanyHit[]> {
  const key = process.env.QCC_APP_KEY?.trim();
  const secret = process.env.QCC_SECRET_KEY?.trim();
  if (!key || !secret) throw new Error("企查查未配置：需要 QCC_APP_KEY / QCC_SECRET_KEY");

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const params = new URLSearchParams({
    key,
    timestamp,
    keyword: query,
    pageIndex: String(options.page ?? 1),
    pageSize: String(Math.min(50, options.limit ?? 20)),
  });
  const url = `${QCC_BASE}/ECIV4/Search?${params.toString()}`;

  const response = await fetch(url, {
    headers: { Token: qccToken(key, timestamp, secret), Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`企查查返回 HTTP ${response.status}（时间戳 ${timestamp}）`);
  }
  const payload = (await response.json()) as {
    Status?: string;
    Message?: string;
    Result?: { Data?: unknown[]; TotalCount?: number };
  };
  if (payload.Status && payload.Status !== "200") {
    throw new Error(`企查查错误 ${payload.Status}：${payload.Message ?? "无说明"}（时间戳 ${timestamp}）`);
  }
  const data = payload.Result?.Data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map(mapQccRow)
    .filter((hit): hit is CompanyHit => hit !== null);
}
