# Python 后端迁移设计

- 日期：2026-11-01
- 状态：第 1 个垂直切片已实现，其余业务按批次迁移
- 目标：Next.js 只负责页面与交互，所有服务端业务逻辑、Agent 编排、数据库访问和外部集成统一由 FastAPI/Python 提供
- 非目标：在行为尚未对齐前一次性删除 TypeScript 后端；同时维护两套业务写路径

## 1. 迁移原则

这次迁移不是把 `.ts` 改名为 `.py`，而是把服务端的**业务所有权**迁到 Python。每个切片必须满足以下条件才允许切换流量：

1. 请求和响应契约与现有前端一致，字段使用 camelCase。
2. 鉴权与租户校验在 Python 侧重新实现，不能依赖前端自行过滤。
3. 每个数据库查询显式带 `organization_id`，跨租户读取按不存在处理。
4. 外部副作用（发消息、写 CRM、改商机阶段）继续由确定性业务层执行；Agent 只做只读判断或产出草稿。
5. 有单元测试覆盖成功、降级、空结果、鉴权失败和上游失败。
6. 只有 Python 切片通过验证后，才删除对应 TypeScript 路由和 `src/lib` 服务。

迁移期间只有一个写入方。禁止 Next.js 和 Python 同时处理同一个请求，也禁止两边各自维护一套业务状态。

## 2. 当前代码事实

- `src/app` 仍有 130 个 TypeScript `route.ts`。
- `src/lib` 仍有约 375 个服务端文件，约 58,000 行代码。
- 页面和 Server Component 中有约 409 处直接引用服务端 `src/lib`；这些引用最终都要改成调用 Python API 或由 Python 渲染。
- Python 后端已建立：FastAPI 入口、内部鉴权、租户头、Pydantic 契约、LangGraph 拓客图、DeepSeek 适配器、企查查适配器和本地企业库查询。
- 当前完成的第一个切片是 `POST /api/prospect/run`，TypeScript 版本暂时保留作为行为对照，尚未切换前端流量。

## 3. 目标边界

```text
Next.js (TypeScript)
  pages / layouts / client components / visual state
        |
        | internal HTTP or server-side proxy
        v
FastAPI (Python)
  api/                 HTTP contract, auth, tenant binding
  services/            use-case composition
  domain/              business rules and Agent graphs
  infrastructure/      Postgres, QCC, DeepSeek, channel adapters
```

五个 Agent 角色的职责保持不变：

| Agent | 回答的问题 | 不允许做的事 |
| --- | --- | --- |
| ProductIntentAgent | 这个产品卖给谁，搜什么公司 | 判断某一家公司值不值得合作 |
| SourcingAgent | 哪些公司可能是买家，是否需要换词重搜 | 直接写 CRM 或发送消息 |
| ScoringAgent | 这一家具体公司值不值得合作 | 让模型返回不可解释的总分 |
| ReplyAgent | 客户这条回复代表什么意图和下一步 | 直接发送回复或修改商机阶段 |
| DraftAgent | 基于画像、上下文和知识库生成什么草稿 | 绕过人工审核直接发送 |

两张业务图分别演进，不创建覆盖全系统的大 Supervisor：

```text
ProspectGraph
  product_intent -> sourcing -> scoring -> contact_enrichment -> finish

CrmReplyGraph
  reply_intent -> optional_research -> drafting
  -> deterministic_review -> human_review -> finish
```

## 4. 已实现的第一个切片

```http
POST /api/prospect/run
Authorization: Bearer <AGENT_BACKEND_TOKEN>
X-Organization-Id: <organization uuid>
X-User-Name: <sales representative, optional>

{"product":"面包丝"}
```

执行链路：

```text
ProductIntentAgent
  -> 本地词典命中，零模型调用
  -> 未命中时调用 DeepSeek 结构化 JSON，失败退回可搜索兜底画像
SourcingAgent
  -> 本地企业库 / 企查查
  -> 按公司名去重，最多 60 家
  -> 少于 5 家时可换词重搜；重搜失败保留第一轮结果
ScoringAgent
  -> 注册资本 25 + 成立年限 20 + 行业匹配 25 + 经营状态 15 + 经营范围 15
  -> 注销/吊销直接 skip
  -> 灰色带深查是可选附加信号，不直接改公式分数
ContactAgent
  -> 电话清洗、去重
  -> 有电话的公司优先，再按合作分排序
finish
```

评分回答的是“这家公司值不值得合作”，不是产品买家画像。产品意图回答的是“这个产品卖给谁”，两者输入、缓存键和验收标准不同。

## 5. 迁移批次

### 批次 1：基础设施与拓客

- 状态：拓客垂直切片已实现。
- 内容包括：内部鉴权、租户绑定、Postgres 企业库查询、DeepSeek、企查查、ProspectGraph、测试。
- 切换条件：前端代理改用 Python 路由；本地库与企查查两条路径都完成真实环境验证。

### 批次 2：认证、组织与线索库

- 迁移登录会话校验、组织成员关系、角色权限。
- 迁移企业、联系人、导入批次和自定义字段。
- Python 侧通过共享数据库读取 Better Auth 会话，不再长期依赖内部静态 token。
- 切换条件：401/403/404 语义与现有 Next.js 一致；跨租户测试通过。

### 批次 3：CRM 回复、分类与草稿

- 建立 `ReplyAgent` 和 `DraftAgent` Python 实现。
- 保留 `contextVersion`、幂等键、旧草稿作废和跟进中断规则。
- 加入确定性审校；人工审核门不能被 Agent 绕过。
- 切换条件：同一入站回复只产生一个分类结果和一套有效草稿。

### 批次 4：队列、Webhook 与渠道

- 迁移企业微信回调、邮件和消息渠道、发送队列与重试。
- 外部副作用全部留在业务服务，不让 Agent 直接调用发送接口。
- 切换条件：重复回调幂等、失败重试、发送前合规检查全部有测试。

### 批次 5：Grid、集成、分析和调度

- 迁移表格、导入导出、集成凭证、统计和内部调度。
- 这一批依赖面最广，最后迁移，避免阻断前面的销售主链路。

### 批次 6：删除 TypeScript 后端

- 逐个删除已经切换的 `route.ts`、服务端 `src/lib` 和相关测试。
- 保留前端组件、样式和纯展示类型。
- 只有在生产观测确认 Python 路由没有回退到 TypeScript 后才执行。

## 6. 前端切换方式

第 1 批先使用 Next.js 服务端代理，不让浏览器直接持有内部 token：

```text
browser -> Next.js proxy -> FastAPI
                          Authorization: Bearer <server-only token>
                          X-Organization-Id: <resolved from session>
```

前端页面不得自行拼接 `X-Organization-Id`。组织 ID 必须来自服务端会话和组织成员校验，否则会形成跨租户入口。

## 7. 验证命令

```powershell
cd backend
python -m pytest
python -m compileall -q app
```

下一批迁移前必须保持全量 Python 测试通过，并补充对应切片的集成测试。
