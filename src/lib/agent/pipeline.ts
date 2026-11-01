import "server-only";

import { runProspectGraph } from "./workflows/prospect/graph";
import type { ProspectWorkflowInput } from "./workflows/prospect/types";

/**
 * 拓客业务入口。
 *
 * 真实的流程编排已经移到 `workflows/prospect/graph.ts`：
 *
 *   ProductIntentAgent -> SourcingAgent -> ScoringAgent -> 电话清洗 -> finish
 *
 * 这里保留原来的函数名，是为了让 API 和已有测试不感知内部拆分。调用方拿到的
 * `ProspectResult` 形状保持不变。
 */
export async function runProspectPipeline(input: ProspectWorkflowInput) {
  return runProspectGraph(input);
}

export { buyerTermsFor, cleanPhones, summarizeResult } from "./workflows/prospect/helpers";
export type { AssessedCompany, ProspectResult } from "./workflows/prospect/types";

// 阶段名与类型放在 pipelineTypes.ts（客户端安全）；这里重导出，调用方不用改 import。
export { PROSPECT_STAGES, STAGE_LABEL, NATURE_LABEL } from "./pipelineTypes";
export type { ProspectStage, ProspectProgress, ProspectStats, AssessmentNature } from "./pipelineTypes";
