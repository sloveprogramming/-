import type { CompanyAssessment } from "@/lib/icp/assess";
import type { ProductIntent } from "@/lib/icp/productIntent";
import type { CompanyHit } from "@/lib/qcc/types";
import type { ArtifactRecorder, DeepCheck, SourcingReplan } from "@/lib/agent/artifacts";
import type { ProspectProgress, ProspectStats } from "@/lib/agent/pipelineTypes";
import type { interpretProduct } from "@/lib/icp/productIntent.server";
import type { searchCompanies } from "@/lib/qcc/provider";
import type { qualifyCompany } from "@/lib/agent/qualifier";
import type { replanSearch } from "@/lib/agent/replanner";

export type AssessedCompany = CompanyAssessment & {
  hit: CompanyHit;
  /** 可打的电话，已排序（优先座机、去重）。 */
  phones: string[];
  /** 有没有联系方式；没有的公司即使分高也很难推进。 */
  reachable: boolean;
  /**
   * 灰色带深查的结论。没触发或深查失败时为 null。
   *
   * 与 `score` 并列而不是合并进分档：分数是公式算的、可解释；深查是附加信号。
   */
  deepCheck: DeepCheck | null;
};

export type ProspectResult = {
  product: string;
  intent: ProductIntent;
  companies: AssessedCompany[];
  stats: ProspectStats;
  runIds: string[];
  traceId: string;
  replan: SourcingReplan | null;
};

export type ProspectWorkflowDependencies = {
  interpret?: typeof interpretProduct;
  search?: typeof searchCompanies;
  recordArtifact?: ArtifactRecorder;
  /**
   * 不传按环境开关决定；传函数强制启用；传 null 强制关闭。
   * 这个三态语义让测试可以精确验证"没触发"和"触发后失败"两种情况。
   */
  replan?: typeof replanSearch | null;
  qualify?: typeof qualifyCompany | null;
};

export type ProspectWorkflowInput = {
  product: string;
  organizationId: string;
  traceId?: string;
  onProgress?: (progress: ProspectProgress) => void;
  signal?: AbortSignal;
  deps?: ProspectWorkflowDependencies;
};
