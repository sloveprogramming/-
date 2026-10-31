/**
 * 企查查接通自检。
 *
 * Run with:  bun scripts/check-qcc.ts [关键词]
 *
 * 为什么单独写一个脚本，而不是直接跑业务页面：
 * `searchCompanies` 在企查查失败时会**静默退回本地结果**（把错误塞进 notice），
 * 这对用户体验是对的，但对"凭据配对了没"这种事是坏的——你会以为接通了。
 * 这里绕过降级，直接调 `searchQcc`，拿到最原始的错误。
 *
 * 只读：不写库、不调模型、不扣业务数据。
 */
import { qccConfigured, searchQcc } from "../src/lib/qcc/client";
import type { CompanyHit } from "../src/lib/qcc/types";

const FIELD_LABELS: Array<{ key: keyof CompanyHit; label: string }> = [
  { key: "name", label: "公司名" },
  { key: "creditCode", label: "统一社会信用代码" },
  { key: "region", label: "地区" },
  { key: "industry", label: "行业" },
  { key: "legalPerson", label: "法定代表人" },
  { key: "foundedAt", label: "成立日期" },
  { key: "registeredCapital", label: "注册资本" },
  { key: "phones", label: "公示电话" },
  { key: "scope", label: "经营范围" },
  { key: "status", label: "经营状态" },
];

function nonEmpty(hit: CompanyHit, key: keyof CompanyHit): boolean {
  const value = hit[key];
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

async function main() {
  const term = process.argv.slice(2).join(" ").trim() || "食品";

  console.log("─".repeat(56));
  if (!qccConfigured()) {
    console.log("✗ 没有读到凭据");
    console.log("");
    console.log("  需要在 AgentSDR/.env.local 里有两行：");
    console.log("    QCC_APP_KEY=你的AppKey");
    console.log("    QCC_SECRET_KEY=你的SecretKey");
    console.log("");
    console.log("  注意：脚本用 bun 跑会自动读 .env.local，不用 export。");
    process.exit(1);
  }
  console.log("✓ 凭据已读到（值不回显）");

  const base = process.env.QCC_BASE_URL?.trim() || "https://api.qichacha.com";
  console.log(`  接口地址：${base}/ECIV4/Search`);
  console.log(`  关键词：${term}`);

  const started = Date.now();
  let hits: CompanyHit[];
  try {
    hits = await searchQcc(term, { limit: 3 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log("");
    console.log("✗ 调用失败：");
    console.log(`  ${message}`);
    console.log("");
    console.log("  排查顺序：");
    console.log("  1. 时间戳偏差 —— 报错里带时间戳，先确认本机时间是准的（签名含 timestamp）");
    console.log("  2. 密钥错位   —— AppKey / SecretKey 有没有互相填反");
    console.log("  3. 接口未开通 —— 开放平台里「企业搜索」这类接口要单独申请权限");
    console.log("  4. 额度用尽   —— 免费测试额度按次计，用完报错也可能是这个");
    process.exit(1);
  }

  const elapsed = Date.now() - started;
  console.log("");
  console.log(`✓ 通了：${hits.length} 家（${elapsed}ms）`);

  if (!hits.length) {
    console.log("  注意：调用成功但一家都没搜到。换个更常见的词再试，");
    console.log("        如果所有词都返回 0，多半是接口权限给的是别的接口。");
    return;
  }

  console.log("");
  for (const [index, hit] of hits.entries()) {
    console.log(`  ${index + 1}. ${hit.name}`);
    console.log(`     ${hit.region ?? "地区未知"} · ${hit.industry ?? "行业未知"} · ${hit.status ?? "状态未知"}`);
    console.log(`     电话：${hit.phones.length ? hit.phones.join(" / ") : "（无）"}`);
  }

  console.log("");
  console.log("  字段覆盖（这几家里有值的比例，决定评分能算多准）：");
  for (const { key, label } of FIELD_LABELS) {
    const filled = hits.filter((hit) => nonEmpty(hit, key)).length;
    const ratio = Math.round((filled / hits.length) * 100);
    const mark = ratio === 100 ? "✓" : ratio === 0 ? "✗" : "·";
    console.log(`    ${mark} ${label.padEnd(10, "　")} ${filled}/${hits.length}`);
  }

  console.log("");
  console.log("─".repeat(56));
  console.log("接下来：在 .env.local 存好后重启 dev server，`/prospect` 页面搜同一个词，");
  console.log("命中数会从本地库的几家里变成全国范围。");
}

main().catch((error) => {
  console.error("脚本本身出错：", error);
  process.exit(1);
});
