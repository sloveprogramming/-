/**
 * 产品拓客流水线的**客户端安全**常量与类型。
 *
 * 为什么单独一个文件：`agent/pipeline.ts` 里有 `server-only`（它要调模型和数据库），
 * 而界面组件需要阶段名和结果形状。从 server 文件 import 会把整条 DB 依赖打进
 * 浏览器包，Next 编译直接失败——这个坑在拜访模块已经踩过一次。
 *
 * 规则很简单：**client 组件只 import 纯数据模块**，哪怕只是想拿一个类型。
 */

export type ProspectStage = "parse" | "search" | "assess" | "contact";

export const PROSPECT_STAGES: readonly ProspectStage[] = ["parse", "search", "assess", "contact"];

export const STAGE_LABEL: Record<ProspectStage, string> = {
  parse: "产品解析",
  search: "检索公司",
  assess: "初筛评估",
  contact: "联系方式",
};

export type ProspectProgress = {
  stage: ProspectStage;
  status: "running" | "done" | "failed";
  detail: string;
  count?: number;
};

export type ProspectStats = {
  searchedTerms: number;
  found: number;
  reachable: number;
  priority: number;
};

/** 评估维度的数据性质——界面上必须区分"实测"与"推断"。 */
export type AssessmentNature = "measured" | "inferred" | "unknown";

export const NATURE_LABEL: Record<AssessmentNature, string> = {
  measured: "实测",
  inferred: "推断",
  unknown: "未知",
};
