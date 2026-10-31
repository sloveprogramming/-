/**
 * 渠道 → 起草约束。
 *
 * 为什么不直接用 `lib/crm/ai/draft.ts` 的 `draftChannelConstraints`：
 * 那份是给「写进 CRM 的完整草稿」用的（面向结构化输出函数），措辞是给模型
 * 的指令。子 Agent 这里的约束更轻——它只生成一段话，不需要约束 JSON 形状。
 *
 * 两者共享同一套业务口径（比如短信 70 字），所以从 draft.ts 复用文字，
 * 只做渠道映射，避免两处口径漂移。
 */
import type { AgentChannel } from "./state";

export function channelConstraintsForDraft(channel: AgentChannel): string[] {
  switch (channel) {
    case "email":
      return ["邮件：可写 200-400 字，有称呼、有落款", "主题要概括这封信的目的"];
    case "wecom":
      return [
        "企业微信：一到四句，像同事发消息，不要称呼行、不要落款",
        "结尾给一个明确动作（发资料 / 约时间）",
      ];
    case "sms":
      return ["短信：一条不超过 70 个汉字，超过会拆条计费", "不要分段、不要落款"];
    case "call":
      return [
        "电话：产出「通话要点」而不是逐字稿",
        "3-5 条，每条一句，销售扫一眼就能打",
      ];
  }
}
