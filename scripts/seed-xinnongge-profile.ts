/**
 * 把新农哥的业务事实、客户画像、首触话术写进 CRM 知识库，并设置起草口径。
 *
 * Run with:
 *   bun --conditions=react-server scripts/seed-xinnongge-profile.ts          # 只看会做什么
 *   bun --conditions=react-server scripts/seed-xinnongge-profile.ts --apply  # 真的写
 *
 * 为什么是知识库而不是硬编码：这三份文档是**业务口径**，会随公司政策变。放在
 * CRM 的知识库里，运营可以自己改，AI 起草每封信都会读到（alwaysInclude 的那篇
 * 进每次起草；其余按标签检索），不用改代码重新部署。
 *
 * 幂等：按标题 upsert，内容没变就不产生新版本。
 * 运行在 ORGANIZATION_ID 指定的组织，未指定时用初始组织。
 */
import { runScriptInOrganization } from "./lib/organization";
import {
  createKnowledgeDocument,
  listKnowledgeDocuments,
  updateKnowledgeDocument,
} from "../src/lib/crm/knowledge-service";
import { renderCompanyBrief } from "../src/lib/icp/profile";
import { renderIcpBrief } from "../src/lib/icp/segments";
import { renderOpenersBrief } from "../src/lib/icp/openers";

type DocSeed = {
  title: string;
  kind: "company" | "product" | "custom";
  tags: string[];
  alwaysInclude: boolean;
  content: string;
};

const DOCS: readonly DocSeed[] = [
  {
    title: "新农哥 · 公司简介与合作政策",
    kind: "company",
    tags: ["company", "product", "pricing", "policy", "xinnongge"],
    // alwaysInclude：每封起草都要知道我们是谁、能承诺什么、不能承诺什么。
    alwaysInclude: true,
    content: renderCompanyBrief(),
  },
  {
    title: "新农哥 · 目标客户画像（ICP）",
    kind: "custom",
    tags: ["icp", "segment", "targeting", "xinnongge"],
    alwaysInclude: true,
    content: renderIcpBrief(),
  },
  {
    title: "新农哥 · 首触话术",
    kind: "custom",
    tags: ["opener", "playbook", "xinnongge"],
    alwaysInclude: false,
    content: renderOpenersBrief(),
  },
];

async function upsert(doc: DocSeed, apply: boolean) {
  const existing = (await listKnowledgeDocuments({ includeArchived: true }))
    .find((document) => document.title === doc.title);

  if (!existing) {
    if (!apply) return { title: doc.title, action: "create" as const };
    const created = await createKnowledgeDocument({
      title: doc.title,
      kind: doc.kind,
      tags: doc.tags,
      alwaysInclude: doc.alwaysInclude,
      content: doc.content,
    });
    return { title: doc.title, action: "created" as const, id: created.id, version: created.latestVersion };
  }

  const contentChanged = existing.latest?.content !== doc.content;
  const metadataChanged = existing.kind !== doc.kind
    || existing.alwaysInclude !== doc.alwaysInclude
    || !existing.active
    || JSON.stringify(existing.tags) !== JSON.stringify(doc.tags);
  if (!contentChanged && !metadataChanged) {
    return { title: doc.title, action: "unchanged" as const, id: existing.id, version: existing.latestVersion };
  }
  if (!apply) return { title: doc.title, action: "update" as const, id: existing.id, contentChanged, metadataChanged };
  const updated = await updateKnowledgeDocument(existing.id, {
    kind: doc.kind,
    tags: doc.tags,
    alwaysInclude: doc.alwaysInclude,
    active: true,
    ...(contentChanged ? { content: doc.content } : {}),
  });
  return {
    title: doc.title,
    action: "updated" as const,
    id: updated.id,
    version: updated.latestVersion,
    contentChanged,
    metadataChanged,
  };
}

async function seed(apply: boolean) {
  const results = [];
  for (const doc of DOCS) results.push(await upsert(doc, apply));
  return results;
}

const apply = process.argv.includes("--apply");
runScriptInOrganization(() => seed(apply))
  .then((summary) => {
    console.log(JSON.stringify({ dryRun: !apply, documents: summary }, null, 2));
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
