/**
 * Agent 之间的通信契约：artifact。
 *
 * ## 为什么是"结构化产物"而不是"对话"
 *
 * 多 Agent 最容易做错的一步，是让角色 A 输出一段自然语言塞给角色 B。后果有三个：
 *
 * 1. 上下文随角色数线性膨胀（每个角色都要读前面所有角色的措辞）
 * 2. B 会被 A 的措辞带偏（A 说"这家公司规模很大"，B 就倾向于给高分）
 * 3. 出错无法定位（分不清是 A 判断错了，还是 B 理解错了）
 *
 * 所以这里定死：**角色之间只传结构化数据**，字段就是两边约定的全部信息。
 * 下游只能看到自己需要的字段，看不到上游的推理过程——这是特性，不是缺陷。
 *
 * ## 为什么用 zod 而不是 TypeScript 类型
 *
 * 类型只在编译期存在。artifact 要落进 jsonb、要跨进程读、将来还要给界面渲染，
 * 这些场景都需要**运行时校验**。而且校验失败时我们能拿到一句人话的错误，
 * 而不是 `undefined is not an object`。
 *
 * ## 这个文件不 import 数据库
 *
 * 契约是纯数据 + 校验，落库在 `artifactStore.ts`（server-only）。分开的好处是
 * 这个文件能在任何环境跑测试，也不会把 db 连接拖进不相关的路径。
 */
import { z } from "zod";

/**
 * 角色名。
 *
 * `researcher` 是已经实现的（起草前调研），其余是本次改造要落地的角色。
 * 先把名字定下来，是为了让 `agent_runs.role` 和 artifact 的 role 从第一天就
 * 对得上——以后加角色不需要改枚举。
 */
export const AGENT_ROLES = [
  "planner",
  "sourcer",
  "qualifier",
  "contact",
  "composer",
  "reviewer",
  "researcher",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/** 界面与日志用的中文名。术语统一靠这里，不要在别处硬编码。 */
export const ROLE_LABEL: Record<AgentRole, string> = {
  planner: "规划员",
  sourcer: "找源员",
  qualifier: "资格员",
  contact: "联系人",
  composer: "写手",
  reviewer: "审校员",
  researcher: "调研员",
};

/** 产物种类。一个角色通常只产出一种，但契约上不绑定，将来可以产出多种。 */
export const ARTIFACT_KINDS = [
  "plan",
  "sourcing",
  "qualification",
  "contact",
  "draft",
  "review",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const KIND_LABEL: Record<ArtifactKind, string> = {
  plan: "搜索计划",
  sourcing: "企业名单",
  qualification: "资格分档",
  contact: "联系方式",
  draft: "草稿",
  review: "审校结果",
};

/**
 * 各角色的默认产物种类。
 *
 * 只用于默认值与界面展示，不用于校验——校验只看 kind 和 payload 是否匹配。
 */
export const ROLE_ARTIFACT: Record<AgentRole, ArtifactKind> = {
  planner: "plan",
  sourcer: "sourcing",
  qualifier: "qualification",
  contact: "contact",
  composer: "draft",
  reviewer: "review",
  researcher: "plan",
};

// ---------------------------------------------------------------------------
// 各 kind 的 payload 契约
// ---------------------------------------------------------------------------
//
// 原则：只放下游真正需要的字段。比如 sourcing 不存 scope / legalPerson 这些
// 明细——资格员是在打分之后写 artifact 的，它不需要回头读原始数据。

/** 规划员：这次要搜什么、为什么。字段与 `ProductIntent` 对齐。 */
const planPayload = z.object({
  /** 用户输入的原话。 */
  query: z.string().min(1),
  /** 判定出的品类，不确定时为 null。 */
  category: z.string().nullable(),
  /** 目标客户类型（ICP 分段）。 */
  segment: z.string().nullable(),
  /** 一句话说明"谁需要它"。 */
  buyerDescription: z.string(),
  /** 拿去搜企业的关键词，已按"产品词 + 买家行业词"组合。 */
  searchTerms: z.array(z.string()).min(1),
  /** 要排除的干扰词。 */
  excludeTerms: z.array(z.string()),
  /** 词典命中还是模型推断——决定销售该信到什么程度。 */
  source: z.enum(["dictionary", "ai"]),
  /** 置信度；词典命中恒为 1。 */
  confidence: z.number().min(0).max(1),
  /** 需要人确认的地方。 */
  uncertainties: z.array(z.string()),
});

/** 找源员：搜了哪些词、每个词命中几家、拿到了哪些公司。 */
const sourcingPayload = z.object({
  terms: z.array(
    z.object({
      term: z.string(),
      hits: z.number().int().nonnegative(),
      /** 该词搜索失败时的原因（限流、未配置账号等）。 */
      error: z.string().optional(),
    }),
  ),
  /** 去重后的公司数。 */
  total: z.number().int().nonnegative(),
  companies: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      region: z.string().nullable(),
      industry: z.string().nullable(),
      status: z.string().nullable(),
      /** 是否已在自家线索库里——重复线索不该二次触达。 */
      inLibrary: z.boolean(),
    }),
  ),
  /**
   * 重规划记录：搜到的太少时，规划员换词重搜过一次。
   *
   * 没触发时整个字段不出现（而不是给一个空对象）——"没跑"和"跑了没效果"
   * 是两件事，混在一起统计会把效果算低。
   */
  replan: z
    .object({
      triggered: z.boolean(),
      newTerms: z.array(z.string()),
      reasoning: z.string(),
      addedCompanies: z.number().int(),
    })
    .optional(),
});

/** 重规划的结果形状，编排层与产物契约共用。 */
export type SourcingReplan = NonNullable<z.infer<typeof sourcingPayload>["replan"]>;

/** 资格员：每家的分数与分档，以及每一维的得分依据。 */
const qualificationPayload = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      score: z.number().min(0).max(100),
      /** 与 `CompanyAssessment.tier` 对齐：优先 / 可联系 / 不建议。 */
      tier: z.enum(["priority", "workable", "skip"]),
      /** 一句话结论。 */
      verdict: z.string(),
      /** 明确标注哪些结论是推断的。 */
      caveats: z.array(z.string()),
      dimensions: z.array(
        z.object({
          key: z.string(),
          label: z.string(),
          score: z.number(),
          max: z.number(),
          /** 人话依据；销售问"为什么 87 分"时能答。 */
          basis: z.string(),
          /** measured 实测 / inferred 推断 / unknown 未知。 */
          nature: z.enum(["measured", "inferred", "unknown"]),
        }),
      ),
      /**
       * 灰色带深查的结论。没触发深查时整个字段不出现。
       *
       * 刻意与 `score` 并列而不是替换它：分数是公式算的、可解释；深查结论是
       * 附加信号。混在一起，销售问"为什么是 87 分"就答不出来了。
       */
      deepCheck: z
        .object({
          verdict: z.enum(["pursue", "hold", "drop"]),
          reasoning: z.string(),
          /** 它查了哪些维度（工具名），便于审计"依据来自哪"。 */
          lookups: z.array(z.string()),
        })
        .optional(),
    }),
  ),
});

/** 深查结论的形状，编排层与产物契约共用。 */
export type DeepCheck = NonNullable<
  NonNullable<z.infer<typeof qualificationPayload>["companies"][number]>["deepCheck"]
>;

/** 联系人：可打的电话与可达性。 */
const contactPayload = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      phones: z.array(z.string()),
      /** 有没有任何联系方式；没电话的公司分再高也难推进。 */
      reachable: z.boolean(),
    }),
  ),
});

/**
 * 写手：一条草稿。
 *
 * 第 2 步（审校员）落地后才会由 composer 实际写入，这里先把契约定下来，
 * 免得那时再改表结构。
 */
const draftPayload = z.object({
  channel: z.string(),
  stepLabel: z.string().nullable(),
  body: z.string().min(1),
});

/**
 * 审校员：草稿是否踩红线。
 *
 * `verdict` 只有两种：pass 直接放行给人审；block 表示命中硬红线（报价、
 * 未经授权的独家承诺），必须改。**审校员不自己改稿**，它只给证据和建议。
 */
const reviewPayload = z.object({
  verdict: z.enum(["pass", "block"]),
  violations: z.array(
    z.object({
      /** 命中的红线名（对应 neverPromise 的条目）。 */
      rule: z.string(),
      /** 原文片段，便于人核对。 */
      quote: z.string().nullable(),
      /** 建议怎么改；没有建议时为 null。 */
      suggestion: z.string().nullable(),
    }),
  ),
});

export const ARTIFACT_SCHEMAS: Readonly<Record<ArtifactKind, z.ZodType>> = {
  plan: planPayload,
  sourcing: sourcingPayload,
  qualification: qualificationPayload,
  contact: contactPayload,
  draft: draftPayload,
  review: reviewPayload,
};

export type PlanPayload = z.infer<typeof planPayload>;
export type SourcingPayload = z.infer<typeof sourcingPayload>;
export type QualificationPayload = z.infer<typeof qualificationPayload>;
export type ContactPayload = z.infer<typeof contactPayload>;
export type DraftPayload = z.infer<typeof draftPayload>;
export type ReviewPayload = z.infer<typeof reviewPayload>;

/** 未校验的产物：角色刚产出时就是这个形状。 */
export type RawArtifact = {
  role: AgentRole;
  kind: ArtifactKind;
  payload: unknown;
};

/**
 * 把产物写进 trace 的函数。
 *
 * 定义在契约文件里（而不是落库文件），是为了让编排层只依赖纯契约——
 * 测试时给一个数组收集器就能验证"角色按顺序产出了什么"，不需要数据库。
 */
export type ArtifactRecorder = (artifact: RawArtifact) => Promise<void>;

/** 校验通过的产物：payload 已被 schema 收窄，可以安全落库。 */
export type ProspectArtifact = {
  role: AgentRole;
  kind: ArtifactKind;
  payload: Record<string, unknown>;
};

export type ArtifactValidation =
  | { ok: true; artifact: ProspectArtifact }
  | { ok: false; error: string };

/**
 * 校验一个产物。
 *
 * 失败时返回人话错误（"qualifier/qualification: 分数不能大于 100"），而不是抛错。
 * 调用方通常是观测层，它不该因为一个字段写错就中断业务。
 */
export function validateArtifact(input: RawArtifact): ArtifactValidation {
  if (!isAgentRole(input.role)) {
    return { ok: false, error: `未知角色：${String(input.role)}` };
  }
  if (!isArtifactKind(input.kind)) {
    return { ok: false, error: `未知产物种类：${String(input.kind)}` };
  }
  const parsed = ARTIFACT_SCHEMAS[input.kind].safeParse(input.payload);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.join(".") ?? "";
    const detail = [path, first?.message].filter(Boolean).join("：");
    return { ok: false, error: `${input.role}/${input.kind} 契约不符：${detail || "参数不合法"}` };
  }
  return {
    ok: true,
    artifact: {
      role: input.role,
      kind: input.kind,
      payload: parsed.data as Record<string, unknown>,
    },
  };
}

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}

export function isArtifactKind(value: unknown): value is ArtifactKind {
  return typeof value === "string" && (ARTIFACT_KINDS as readonly string[]).includes(value);
}

/**
 * 一个 trace 里产物应该出现的顺序。
 *
 * 用来校验"链路是否完整"：缺哪一段一眼能看出来，不用逐个比对 kind。
 * 注意这不是执行顺序的强约束——将来允许跳步（比如没有电话就直接进培育池）。
 */
export const ARTIFACT_FLOW: readonly ArtifactKind[] = [
  "plan",
  "sourcing",
  "qualification",
  "contact",
  "draft",
  "review",
];

/** 给定已产出的种类，返回还没产出的那些（按流程顺序）。 */
export function missingArtifacts(produced: readonly ArtifactKind[]): ArtifactKind[] {
  const seen = new Set(produced);
  return ARTIFACT_FLOW.filter((kind) => !seen.has(kind));
}
