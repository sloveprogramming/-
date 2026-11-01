# 多 Agent 业务迁移与拓客评分设计

- 日期：2026-11-01
- 状态：阶段 1 已实施；阶段 2-5 待实施
- 范围：AgentSDR 的拓客、CRM 回复、业务能力分层与后续多 Agent 迁移
- 决策基线：业务主干保持确定性；产品买家画像和公司合作判断分别建模；Agent 不直接执行外部副作用

## 1. 结论

当前项目是“确定性业务主干 + 局部 Agent 工作流”，不是一个覆盖全系统的大
Supervisor。真实状态是：

- 拓客主链路已经由 `ProspectGraph` 编排，并在 `/api/prospect/run` 的生产路径中运行。
- `ProductIntentAgent`、`SourcingAgent`、`ScoringAgent` 是三个独立图节点。
- `SourcingAgent` 和 `ScoringAgent` 的增强能力仍是可选开关；关闭时走确定性主路径。
- CRM 回复链路的 `ReplyAgent`（分类）和 `DraftAgent`（起草）已有生产实现，但尚未合并
  成跨队列作业的 `CrmReplyGraph`。
- 旧的、仅测试引用的 LangGraph 原型已经删除，避免与生产图并存造成误判。

### 1.1 已落地的代码边界

| 能力 | 生产实现 | 当前编排层级 |
| --- | --- | --- |
| 产品买家画像 | `src/lib/icp/productIntent.server.ts` | L1 单次结构化 AI + 词典快路径 |
| 找企业 | `src/lib/agent/workflows/prospect/nodes.ts` + `qcc/provider.ts` | L0 确定性搜索 + 可选 L2 换词 Agent |
| 公司合作评分 | `src/lib/icp/assess.ts` + `agent/qualifier.ts` | 确定性基础分 + 可选只读证据深查 |
| 拓客流程 | `src/lib/agent/workflows/prospect/graph.ts` | L3 局部 LangGraph 工作流 |
| 客户回复判断 | `src/lib/crm/ai/classify.ts` | L1 单次结构化 AI |
| 回复/跟进草稿 | `src/lib/crm/ai/draft.ts` + `crm/drafts.ts` | L1 单次结构化 AI + 确定性审校 + 人工审核 |

五个角色的共同边界定义在 `src/lib/agent/workflows/contracts.ts`。Agent 只能无副作用
或只读；草稿必须人工审核；最终评分由确定性聚合器计算，模型不能直接返回不可解释的总分。

迁移方向不是把全部业务交给一个 Supervisor，而是按业务旅程建立局部 Agent 图：

```text
确定性业务主干
  -> 局部 Agent 工作流
  -> 受控工具
  -> 业务服务与外部副作用
```

本次设计先解决拓客链路中的两个核心判断：

1. **ProductBuyerProfileAgent**：产品应该卖给谁，应该搜什么词。
2. **CompanyCooperationAgent**：一家具体公司是否值得合作，以及为什么。

最终数字分由确定性聚合器计算。Agent 负责搜集证据、解释判断和有界调整，不负责直接写死一个不可解释的总分。

## 2. 背景

### 2.1 当前真实链路

`src/app/api/prospect/run/route.ts` 仍调用 `runProspectPipeline`，但该函数现在是一个薄
入口，真正的编排在 `runProspectGraph`：

```text
POST /api/prospect/run
  -> runProspectPipeline
  -> runProspectGraph
       ProductIntentAgent
       -> SourcingAgent
       -> ScoringAgent（可选灰色带深查）
       -> contact_enrichment（确定性）
       -> finish
```

对应代码：

- `src/lib/agent/pipeline.ts`：兼容入口。
- `src/lib/agent/workflows/prospect/graph.ts`：图结构与执行入口。
- `src/lib/agent/workflows/prospect/nodes.ts`：三个 Agent 节点和确定性收尾节点。
- `src/lib/agent/workflows/prospect/state.ts`：节点之间传递的结构化状态。
- `src/lib/icp/productIntent.server.ts`：产品买家画像解析。
- `src/lib/icp/assess.ts`：可解释的基础合作评分。
- `src/lib/agent/qualifier.ts`：灰色带只读深查，不直接修改基础分。

### 2.2 旧原型已移除

原先 `src/lib/agent/graph` 中的 `supervisor -> research / assess_intent / draft / close / finish`
原型只被自己的测试引用，且存在两类误导：

- `assess_intent` 是关键词启发式，不是客户回复分类。
- `draft` 是模板/词典生成，不是真实草稿模型。

该目录已删除。当前保留的唯一生产图是 `ProspectGraph`；`CrmReplyGraph` 的接入
必须等待 Queue、上下文版本、幂等和人工审核边界设计完成，不能复用旧原型冒充迁移。

### 2.3 当前术语问题

“意图”被用于三个不同问题：

| 问题 | 当前术语/实现 | 正确边界 |
| --- | --- | --- |
| 这个产品卖给谁？ | `ProductIntent` | 产品买家画像，不是客户合作判断 |
| 这家公司值不值得合作？ | `CompanyAssessment` | 公司合作潜力评估 |
| 客户回复代表什么态度？ | CRM 回复分类 | 回复意向分类 |

这三个概念不能合并成一个“意图 Agent”。否则输入输出、缓存键、人工审核点和验收标准都会混在一起。

## 3. 目标与非目标

### 3.1 目标

- 建立业务能力清单，明确哪些是确定性业务、单次 AI、工具 Agent、多 Agent 工作流。
- 把产品买家画像和公司合作判断拆成两个独立能力。
- 引入有界的公司合作评分模型，支持缺失数据和数据置信度。
- 用按业务旅程拆分的 LangGraph 图承载真正的多 Agent 协调。
- 保留现有 `agent_runs`、`agent_events`、`agent_artifacts` 观测基础。
- 所有外部副作用保留在 Agent 图之外，通过业务服务、审批和幂等队列执行。
- 先迁移低风险、只读的拓客链路，再迁移 CRM 回复。

### 3.2 非目标

- 不把 CRM CRUD、邮件发送、跟进序列、Webhook、数据表 CRUD 迁移成 Agent。
- 不允许 Agent 直接发送邮件、发短信、修改商机阶段或删除数据。
- 不用 LLM 自由生成一个不可解释的 0-100 总分。
- 不做一个覆盖全系统的大 Supervisor。
- 不把 Milvus 向量库迁移作为第一阶段前置条件。
- 不在本设计阶段修改当前业务代码。

## 4. 分层原则

| 层级 | 定义 | 例子 | 处理方式 |
| --- | --- | --- | --- |
| L0 确定性能力 | 输入输出可完全由代码复现 | 搜索、评分公式、发送队列、状态机、CRUD | 保持纯函数或业务服务 |
| L1 单次 AI 能力 | 一次结构化模型调用，无工具循环 | 回复分类、草稿生成、公式生成 | 保持单次调用，严格校验输出 |
| L2 工具型 Agent | 模型决定是否调用工具、可循环 | 产品画像、公司深查、调研 | 有工具预算、超时、只读工具 |
| L3 多 Agent 工作流 | 多个节点通过图协调，可中断恢复 | ProspectGraph、CrmReplyGraph | 每段独立图，有检查点、降级和人工审核 |

判断标准：

- 如果业务只需要固定顺序执行，使用 L0 或 L1。
- 如果模型需要根据中间结果主动查询工具，使用 L2。
- 如果需要跨多个判断步骤、动态路由、失败隔离或人工中断，使用 L3。
- “自动化”不等于 Agent；只有模型参与决策和工具选择，才进入 L2 及以上。

## 5. 业务能力清单

| 业务域 | 主要入口 | 当前实现 | 当前层级 | 迁移决定 |
| --- | --- | --- | --- | --- |
| 产品拓客 | `/prospect`、`/api/prospect/run` | 固定流水线加可选重规划/深查 | L0 + L1 + 可选 L2 | 第一批接入 ProspectGraph |
| 找客户 | `/prospecting` | 产品画像、搜索、导入 | L0 + L1 | 复用为 ProspectGraph 的能力 |
| 电话名单 | `/phone` | 产品画像、搜索、规则话术 | L0 + L1 | 保留确定性话术 |
| CRM 回复 | `/crm/actions`、`/outreach/inbox` | 分类、可选调研、草稿、人工审核 | L1 + 可选 L2 | 第二批接入 CrmReplyGraph |
| 邮件营销 | `/outreach/campaigns` | 队列、发送、状态机、Webhook | L0 | 不迁移，只暴露业务服务 |
| CRM 商机/序列/拜访 | `/crm/pipeline`、`/crm/sequences`、`/visits` | 记录、阶段、跟进状态 | L0 | 不迁移 |
| 客户线索 | `/leads` | 导入、字段、查询、CRUD | L0 | 不迁移 |
| 数据表 | `/tables` | 表格 CRUD、AI 列、公式生成 | L0 + L1 | 保留；后续可作为工具 |
| 分析/设置/权限 | `/analytics`、`/settings` | 聚合、组织、成员、权限 | L0 | 不迁移 |
| 知识库 | CRM 知识检索 | PostgreSQL 检索；Milvus 代码未接入业务 | L0 + AI 基础设施 | 先作为 Research 工具 |
| 旧域名/旧活动 | `/domains`、`/campaigns`、`/api/qualify` | 旧资格审核链路，不在当前导航 | L0 + L1 | 标记历史，单独淘汰 |

## 6. 目标架构

```text
页面 / API
    |
    v
业务工作流层：权限、租户、状态、幂等、审批、外部副作用
    |
    +--> ProspectGraph
    +--> CrmReplyGraph
    +--> 其他按旅程拆分的局部图
              |
              v
        Agent 节点层
        - 单次结构化 AI
        - 工具循环 Agent
        - 人工中断节点
              |
              v
        只读工具与确定性能力
        - 企业搜索
        - 企查查信号
        - CRM 查询
        - 知识检索
        - 评分纯函数
              |
              v
        业务服务 / 数据库 / 外部渠道
```

### 6.1 主流程与子流程

主流程负责业务目标和持久状态：

```text
产品 -> 找公司 -> 初步判断 -> 联系人 -> 触达 -> 客户回复 -> 人工审核 -> 发送 -> 跟进
```

子流程负责某一步中的判断：

```text
产品画像、换词重搜、公司深查、回复分类、调研、起草、审校
```

主流程不把“当前做到哪一步”交给模型保存；模型也不直接决定“现在发不发邮件”。这是可恢复性和安全边界的基础。

### 6.2 每段业务一张图

不建立一个全局 Supervisor。每个业务旅程独立建图：

- `ProspectGraph`：从产品到可选联系人名单。
- `CrmReplyGraph`：从客户回复到人工审核通过的草稿。
- 后续 `FollowupGraph`、`KnowledgeGraph` 在数据和评测稳定后再引入。

跨图复用通过工具和结构化契约完成，不通过“把上一张图的自然语言输出塞给下一张图”完成。

### 6.3 Agent 节点契约

每个节点必须声明：

```text
id
kind: deterministic | single_ai | agent | human_review
input_schema
output_schema
tools[]
budget.max_tool_calls
budget.timeout_ms
budget.max_rounds
fallback
side_effects: none | read | write
human_review: never | conditional | always
```

任何节点都不允许以自然语言作为下游唯一输入。节点之间只传结构化 artifact，并在边界做运行时校验。

### 6.4 外部副作用

- Agent 只获得只读工具。
- 发送邮件、发送短信、写 CRM、修改商机阶段必须经过业务服务。
- 所有外部副作用必须有幂等键、审计记录和失败重试策略。
- 有副作用的动作必须在图外执行，或在图中通过 `interrupt` 等待人工审批。

## 7. ProspectGraph

### 7.1 图结构

```text
START
  -> product_buyer_profile       ProductBuyerProfileAgent
  -> company_search              确定性
  -> maybe_replan_search         可选 ReplanAgent
  -> base_company_score          确定性
  -> company_cooperation_gate    确定性路由
       -> deterministic_only
       -> company_cooperation    CompanyCooperationAgent
  -> cooperation_score_aggregator 确定性
  -> contact_enrichment          确定性
  -> finish
END
```

### 7.2 路由规则

`company_cooperation_gate` 只在以下条件之一成立时调用 Agent：

- 基础分位于 40-65 的灰色带。
- 关键维度缺失，导致 `coverage < 0.7`。
- 公司可联系电话存在且基础分位于前 20%。
- 销售显式请求“深查”。

第一版每次运行最多深查 2 家公司；上限通过配置控制，不允许模型自行扩大。

### 7.3 状态与产物

建议图状态包含：

```text
trace_id
organization_id
product_query
buyer_profile
search_terms
sourcing_result
base_assessments
cooperation_evidence
final_assessments
budget
errors
```

现有 artifact 角色和种类可以继续使用，并新增清晰的产品画像与公司合作产物契约。所有产物共享同一个 `trace_id`。

### 7.4 失败降级

- 产品画像 Agent 失败：退回词典或 `fallbackIntent` 等价结果，并在结果中标记低置信度。
- 搜索失败：保留已搜到的公司，不中断整条图。
- 重规划失败：使用第一轮搜索词，不阻塞评分。
- 公司合作 Agent 失败：保留基础分和 `review_required` 标记，不伪造深查结论。
- 电话清洗失败：保留公司记录，`reachable=false`，不中断列表生成。

## 8. ProductBuyerProfileAgent

### 8.1 职责

回答：**这个产品卖给谁，应该用什么词去找这些买家。**

它不判断某一家公司的合作意愿，也不直接决定销售是否发送邮件。

当前 `ProductIntent` 的字段可以作为兼容基础，但 UI 和文档统一显示为“产品买家画像”，避免和“客户合作意向”混淆。

### 8.2 快速路径

1. 规范化产品词。
2. 查询本地产品词典。
3. 只有一个明确命中且没有歧义时，直接返回，不调用模型。
4. 词典未命中、命中多个候选、包含地区叫法、组合产品或低置信度时，进入 Agent。

词典从“唯一方案”变成“快速路径和工具”，不再阻碍新品类识别。

### 8.3 工具

- `lookup_product_dictionary`：返回命中的词典条目和候选品类。
- `lookup_industry_taxonomy`：把品类映射到行业/经营范围词。
- `probe_company_search`：用一个候选关键词做小样本搜索，返回命中和样例；不返回全量企业数据。
- `lookup_org_product_feedback`：读取本组织过去的人工修正记录。
- `lookup_icp_segments`：读取允许的客户类型。

工具全部只读。搜索类工具每次最多返回 5 条样例，避免上下文膨胀。

### 8.4 输出

```text
product
category
segment
buyer_description
buyer_signals[]
search_terms[]
excluded_terms[]
confidence
uncertainties[]
evidence[]
needs_user_confirmation
```

`search_terms` 中每个词应包含：

```text
term
reason
expected_buyer_type
probe_hits
probe_samples[]
```

### 8.5 预算与降级

- 最多 6 次工具调用。
- 最多 2 轮模型修正。
- 超时 20 秒。
- 失败时退回词典/兜底画像，并保留原始产品词。
- 置信度低于 0.65 时标记 `needs_user_confirmation`，界面允许人工修改买家和搜索词。

### 8.6 缓存与学习

缓存键为：

```text
organization_id + normalized_product + taxonomy_version
```

人工修正不覆盖全局词典，只写入组织级反馈，作为下一次 Agent 的上下文。这样可以避免一个销售的临时判断污染所有租户。

## 9. CompanyCooperationAgent

### 9.1 职责

回答：**这家具体公司是否值得合作，为什么，证据有多可靠。**

它不负责决定邮件内容，也不负责直接改 CRM 或发送消息。

“公司意图”不是一个可以直接读取的字段。设计中使用可观测的需求信号来近似，例如：

- 在招采购、渠道、销售岗位。
- 有招标/中标记录。
- 近期扩张、分支机构或业务变更。
- 经营范围、产品线和渠道能力。
- 资质、许可证和食品安全记录。

没有证据时必须写“未查到”，不能把未查到解释成“没有需求”。

### 9.2 触发条件

只对以下公司运行：

- 基础分 40-65。
- 关键字段缺失，覆盖率不足。
- 基础分排名靠前且可联系电话存在。
- 用户主动请求深查。

默认每次最多 2 家公司。其余公司保留基础分和 `review_required` 标记。

### 9.3 输入

```text
company_facts
buyer_profile
base_assessment
organization_id
optional_crm_history
optional_previous_evidence
```

### 9.4 工具

第一版复用现有只读企查查工具：

- `lookup_company_profile`
- `lookup_recruitment`
- `lookup_bidding`
- `lookup_qualifications`
- `lookup_food_safety`

后续可以增加：

- 官网/公开网页读取。
- 组织内历史成交和跟进记录。
- 知识库检索。

所有工具都返回“样本 + 摘要 + 来源 + 时间”，不返回无限量原文。

### 9.5 评分模型

建议的满分 100 维度：

| 维度 | 权重 | 主要信号 |
| --- | ---: | --- |
| 需求匹配 demand_fit | 30 | 行业、产品、经营范围、买家画像匹配 |
| 公司体量与履约能力 capacity | 20 | 注册资本、成立年限、规模、参保人数 |
| 经营活跃度 activity | 20 | 经营状态、招聘、招投标、扩张和近期变化 |
| 渠道能力 channel_fit | 20 | 批发、经销、零售、供应链、食品资质 |
| 风险与合规 risk | 10 | 经营异常、处罚、食品安全、诉讼等 |

子维度到主维度的映射必须固定，不允许模型自由改权重。

### 9.6 缺失数据

缺失数据不能按 0 分处理，否则会把“没查到”误判成“条件差”。

对每个维度分别记录：

```text
score: 0-100 | null
weight
known: boolean
evidence_refs[]
```

聚合规则：

```text
known_weight = 所有已知维度的权重和
weighted_score = 已知维度分数按权重归一化
coverage = known_weight / 100
raw_score = weighted_score
final_score = clamp(raw_score + bounded_adjustment, 0, 100)
```

如果 `coverage < 0.5`，结果必须标记为 `review_required`，不能自动成为“优先联系”。

### 9.7 Agent 输出

Agent 不直接输出最终分数，只输出证据和有界调整：

```text
evidence[]:
  dimension
  signal
  source
  observed_at
  value
  confidence
  polarity

adjustments[]:
  dimension
  delta
  reason
  evidence_refs

risk_flags[]:
  code
  severity
  summary
  source

verdict: pursue | hold | drop
reasoning
uncertainties[]
```

约束：

- 每条调整必须有至少一条证据引用。
- 单个维度调整最多 ±5 分。
- 总调整最多 ±10 分。
- Agent 不能设置最终分数、最终分档或外部动作。
- 没有证据的维度不得产生调整。

### 9.8 最终聚合

确定性聚合器执行：

```text
final_score = clamp(base_score + sum(valid_adjustments), 0, 100)
```

然后应用硬性风险规则：

- 注销、吊销、撤销或严重合规阻断：`outreach_blocked = true`。
- 重大食品安全/经营风险：总分封顶并进入人工复核。
- 轻微风险：只提示，不直接阻断。

分档建议：

```text
blocked: 硬性风险或 outreach_blocked
priority: final_score >= 70 且 confidence >= 0.6
workable: final_score >= 45
skip: final_score < 45
review_required: coverage < 0.5 或 confidence < 0.55
```

`review_required` 是独立标记，不替代基础 tier。被标记的公司不能自动升为优先联系。

### 9.9 置信度

建议：

```text
confidence = coverage
           * source_reliability
           * evidence_consistency
```

- `source_reliability`：官方登记信息高于第三方网页，第三方网页高于模型推断。
- `evidence_consistency`：多个来源冲突时降低置信度。
- 缺失数据只能降低置信度，不能自动降低分数。

### 9.10 成本和延迟

- 每家公司最多 5 次工具调用。
- 每家公司最多 1 轮补充查询，超时 30 秒。
- 每次拓客运行最多深查 2 家公司。
- 其余公司快速返回基础分，不等待 Agent。

## 10. CrmReplyGraph

CRM 回复链路后续采用类似边界，但不在第一版启用：

```text
reply_intent
  -> optional research
  -> draft
  -> deterministic review
  -> human_review (interrupt)
  -> send (图外业务服务)
```

关键约束：

- 回复分类可以继续是 L1 单次调用，不需要为了“多 Agent”强行改成工具循环。
- 调研 Agent 只读。
- 草稿生成后必须经过规则审核和人工审批。
- 发送不在 Agent 图内执行。
- 发送失败由业务队列和幂等逻辑处理，不由模型重试。

## 11. 观测与契约

继续使用：

- `agent_runs`
- `agent_events`
- `agent_artifacts`

新增执行类型建议：

- `product_profile`
- `cooperation_assessment`

每次运行至少记录：

```text
trace_id
node_id
graph_version
kind
model
prompt_version
tool_calls
input_tokens
output_tokens
cost_usd
duration_ms
fallback_used
human_reviewed
```

所有产物必须能回答：

- 这是哪个产品的画像？
- 这是哪家公司的判断？
- 依据是什么？
- 来自哪个工具或数据源？
- 哪些维度未知？
- Agent 调整了多少，为什么？
- 能否用相同输入重放出相同最终分？

## 12. 评测

### 12.1 单元测试

- 词典命中时不调用模型。
- 词典未命中和低置信度时进入 Agent。
- 工具调用次数和超时边界。
- 产品画像输出 schema 校验。
- 公司基础分、未知数据处理、覆盖率和置信度。
- Agent 调整上限、证据缺失时拒绝调整。
- 硬性风险阻断和分档规则。
- 聚合结果可从 artifact 重放。

### 12.2 集成测试

- 使用假的企业搜索工具，验证 ProspectGraph 的路由和降级。
- 使用假的 QCC 工具，验证灰色带才触发 CompanyCooperationAgent。
- 验证 Agent 失败时仍返回基础分列表。
- 验证 traceId 贯穿所有产物和执行记录。

### 12.3 质量评测

建立一个最小黄金集：

- 至少 20 个不同产品的买家画像。
- 至少 100 家公司的合作判断样本。
- 每个样本记录人工期望：优先、可联系、不建议、证据不足。

评测指标：

- 产品画像搜索词的命中率。
- 公司优先级排序的 top-10 精确率。
- 灰色带样本的人工采纳率。
- Agent 结论与证据的一致性。
- 缺失数据被误判为负分的比例。
- 成本和延迟分布。

发布门槛：

- 新的 top-10 精确率不低于现有确定性基线。
- 所有最终分数都能从 artifact 解释和重放。
- 硬性风险漏报为零。
- Agent 失败不导致拓客接口整体失败。

## 13. 迁移阶段

每个阶段独立提交、独立验证、独立推送 `origin`。

### 阶段 0：文档与边界

- 落本文档。
- 修正“四个 Agent”等误导性注释。
- 标记旧 `/domains`、`/campaigns`、`/api/qualify` 为历史链路。
- 不改变业务行为。

### 阶段 1：ProspectGraph 骨架（已完成）

- 用 LangGraph 表达现有四段流水线。
- 所有节点先复用确定性函数。
- 保持现有 API 返回结构。
- 不启用新 Agent。

实现结果：

- 生产入口仍为 `runProspectPipeline`，内部改为 `runProspectGraph`。
- 图节点为 `product_intent -> sourcing -> scoring -> contact -> finish`。
- 原有 `plan / sourcing / qualification / contact` artifact 顺序和 API 响应不变。
- 删除只被测试引用的旧 `src/lib/agent/graph` 原型。

### 阶段 2：ProductBuyerProfileAgent

- 先 shadow 模式运行，只记录不改变结果。
- 词典未命中时启用。
- 人工可修正买家画像和搜索词。
- 通过评测后再替换默认解析。

### 阶段 3：CompanyCooperationAgent

- 先 shadow 模式，对灰色带公司产生证据和建议，但不改变 UI 排序。
- 验证证据质量和成本后，启用有界分数调整。
- 所有调整和风险进入 artifact。

### 阶段 4：ProspectGraph 正式路由

- 产品画像、重规划、公司合作 Agent 作为图节点运行。
- 保留开关和降级路径。
- 统一 trace 和成本展示。

### 阶段 5：CrmReplyGraph

- 只在 ProspectGraph 稳定后开始。
- 先接入分类和草稿的确定性编排。
- 再接入调研 Agent。
- 发送始终在外面。

## 14. 开关与回滚

建议开关：

```text
AGENT_PRODUCT_PROFILE=off|shadow|on
AGENT_COMPANY_COOPERATION=off|shadow|on
AGENT_PROSPECT_GRAPH=off|on
```

当前已经存在并实际使用的兼容开关：

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `AGENT_REPLAN_SEARCH` | `SourcingAgent` 结果不足时启用只读换词探测 | 关闭 |
| `AGENT_QUALIFY_GRAY_ZONE` | `ScoringAgent` 对灰色带公司启用只读证据深查 | 关闭 |
| `AGENT_RESEARCH_BEFORE_DRAFT` | CRM 起草前启用只读调研 Agent | 关闭 |

`AGENT_PRODUCT_PROFILE`、`AGENT_COMPANY_COOPERATION`、`AGENT_PROSPECT_GRAPH` 是后续
shadow / 全量迁移要增加的开关；当前阶段不要把它们写进部署配置后误以为已生效。

规则：

- `shadow`：运行并记录，但业务结果使用旧路径。
- `on`：使用 Agent 结果。
- `off`：完全走确定性路径。

回滚不使用数据删除或重写历史。关闭开关即可回到上一路径；已生成的 artifact 保留用于审计。

## 15. 已确定的默认决策

| 主题 | 默认决策 |
| --- | --- |
| 多 Agent 范围 | 每个业务旅程一张图，不做全局大 Supervisor |
| 产品画像 | 词典快速路径 + 低置信度工具型 Agent |
| 公司评分 | 确定性基础分 + 有界 Agent 调整 + 确定性聚合 |
| 全量还是抽样 | 基础分全量；Agent 只处理灰色带/高价值/数据缺失 |
| 未知数据 | 不用 0 分；降低 coverage 和 confidence |
| Agent 工具 | 第一版全部只读 |
| 发送动作 | 图外执行，人工审批和幂等保护 |
| 模型配置 | 复用现有 OpenRouter BYOK / Pi 配置，不新增硬编码密钥 |
| 第一版试点 | 产品拓客，只读、可回滚、风险最低 |

## 16. 下一步

阶段 1 已落地。后续按顺序推进：

1. 为 `ProductIntentAgent` 增加工具型探测、组织级人工修正和 shadow 评测。
2. 把 `ScoringAgent` 的灰色带证据输出扩展为“基础分 + 有界调整 + coverage/confidence”，
   并保证最终总分只能由确定性聚合器生成。
3. 在 CRM 的 Queue、上下文版本、幂等和人工审核边界稳定后，再接入
   `ReplyAgent -> optional research -> DraftAgent -> deterministic review -> human_review`。

每一步仍需单独提交、运行类型检查/静态检查/相关测试，并推送 `origin`。
