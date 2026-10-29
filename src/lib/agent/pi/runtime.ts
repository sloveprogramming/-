import "server-only";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { getByokSettings } from "@/lib/ai/byok";
import { ensurePiAgentDir } from "./sandbox";

/**
 * Pi SDK 的模型运行时：把项目里存的 OpenRouter 凭据交给 Pi。
 *
 * 为什么不用 Pi 自带的凭据存储：Pi 的 `SessionManager` / `SettingsManager` 是
 * **文件式**的（写 ~/.pi/...）。这个项目是多租户部署，凭据存在数据库里、
 * 加密存的是每个组织自己的一份（`grid_provider_credentials`）。让 Pi 去读
 * 文件会绕开租户隔离，也会把 key 落到磁盘上。
 *
 * 所以这里做的是：**每个组织、每次调用时，用数据库里的 key 现建一个
 * ModelRuntime**，用完即弃。代价是每次多一次 credential 同步（毫秒级），
 * 换来的是凭据不落盘、租户不串。
 *
 * 关于 provider：Pi 原生支持 42 个 provider，包括 openrouter（401 个模型）
 * 和 deepseek。所以不需要写自定义 provider，只要把 key 塞进去。
 */

export type PiModelChoice = {
  providerId: string;
  modelId: string;
};

/** 从数据库读当前组织的模型设置。失败时回落到环境变量（本地开发用）。 */
export async function resolveModelChoice(): Promise<{
  choice: PiModelChoice;
  apiKey: string;
  /** 凭据来源，便于日志排查。 */
  source: "database" | "env";
}> {
  // ---- 1. 优先用数据库里的 BYOK 设置（这是生产路径）----
  try {
    const settings = await getByokSettings();
    const selection = settings.defaultModel;
    if (settings.connectionId && selection) {
      const connection = await getAiConnection(settings.connectionId);
      if (connection?.verified) {
        const credentials = await getAiCredentials(connection.id);
        if (credentials?.apiKey) {
          // Pi 的 providerId 与项目里的 provider 名不一定同名，做一次映射。
          return {
            choice: { providerId: piProviderId(connection.providerKey), modelId: selection.modelId },
            apiKey: credentials.apiKey,
            source: "database",
          };
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // **不能对所有错误都静默降级到环境变量。**
    //
    // "没有组织作用域"是**编程错误**（调用链漏了 runInOrganization），不是
    // "这家没配 AI"。吞掉它会让生产环境用环境变量的 key 处理本该属于某个
    // 组织的数据——跨租户用凭据，而且不报错，最难排查。
    //
    // 所以区分两类：
    //   - 配置缺失（没连 OpenRouter / 没验证）→ 可以降级到 env
    //   - 作用域 / 权限 / 认证错误 → 直接抛出
    if (/organization scope|NOT_A_MEMBER|FORBIDDEN|UNAUTHENTICATED|NO_ACTIVE_ORGANIZATION/i.test(message)) {
      throw new Error(
        `Agent 无法读取 AI 凭据：${message}。` +
        "这通常说明调用链没有包在 runInOrganization() 里——修调用方，不要用环境变量绕过。",
      );
    }
    console.warn("[agent/pi] 读取数据库凭据失败，尝试环境变量：", message);
  }

  // ---- 2. 环境变量兜底（本地开发 / 演示）----
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) {
    return {
      choice: { providerId: "deepseek", modelId: process.env.AGENT_MODEL_ID?.trim() || "deepseek-flash" },
      apiKey: envKey,
      source: "env",
    };
  }
  const openrouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouterKey) {
    return {
      choice: {
        providerId: "openrouter",
        modelId: process.env.AGENT_MODEL_ID?.trim() || "deepseek/deepseek-chat",
      },
      apiKey: openrouterKey,
      source: "env",
    };
  }

  throw new Error(
    "没有可用的模型凭据。去「设置 → AI 模型」连接 OpenRouter，或设置 DEEPSEEK_API_KEY / OPENROUTER_API_KEY。",
  );
}

/** 项目里的 provider 名 → Pi 的 providerId。 */
function piProviderId(providerKey: string): string {
  const normalized = providerKey.trim().toLowerCase();
  const map: Record<string, string> = {
    openrouter: "openrouter",
    deepseek: "deepseek",
    openai: "openai",
    anthropic: "anthropic",
    google: "google",
  };
  return map[normalized] ?? normalized;
}

export type PiRuntimeHandle = {
  modelRuntime: ModelRuntime;
  model: Awaited<ReturnType<ModelRuntime["getModels"]>>[number];
  providerId: string;
  modelId: string;
};

/**
 * 构造一个可用的 Pi 模型运行时。
 *
 * 每次调用都新建：凭据可能刚被改过，缓存会用到过期的 key。
 * ModelRuntime.create() 本身很轻（不发起网络请求）。
 *
 * @param requested 调用方指定的模型。传了就用它，不传用组织的默认模型。
 *   **指定后校验失败要抛错，不能静默回落到默认模型**——调用方显式指定了模型
 *   （比如为了省钱选小模型），悄悄换成默认模型会让成本和质量都不符合预期。
 */
export async function createPiRuntime(requested?: PiModelChoice | null): Promise<PiRuntimeHandle> {
  const resolved = await resolveModelChoice();
  const apiKey = resolved.apiKey;
  const source = resolved.source;

  // 显式指定的模型优先；但凭据要按 provider 重新解析（指定 provider 可能和默认不同）。
  let choice: PiModelChoice = resolved.choice;
  if (requested?.providerId && requested.modelId) {
    choice = { providerId: piProviderId(requested.providerId), modelId: requested.modelId };
  }

  // 重定向 Pi 的配置目录到进程私有临时目录：避免写 ~/.pi（多租户会串、
  // 容器里没持久卷、key 落到磁盘）。必须在 ModelRuntime.create 之前。
  ensurePiAgentDir();
  const modelRuntime = await ModelRuntime.create();

  // providerIds 是私有字段，运行时用 getProviders() 拿公开列表。
  const available = (modelRuntime.getProviders() ?? []).map((entry) => entry.id);
  if (!available.includes(choice.providerId)) {
    throw new Error(
      `Pi 不支持 provider「${choice.providerId}」。支持的：${available.join("、")}`,
    );
  }

  await modelRuntime.setRuntimeApiKey(choice.providerId, apiKey);

  const models = modelRuntime.getModels(choice.providerId) ?? [];
  const model = models.find((entry) => entry.id === choice.modelId);
  if (!model) {
    // 指定了模型的调用方不该被悄悄替换成别的模型。
    if (requested?.modelId) {
      throw new Error(
        `provider「${choice.providerId}」下没有模型「${requested.modelId}」。可选的：` +
        `${models.map((m) => m.id).join("、") || "（无）"}`,
      );
    }
    // 没指定时回落到该 provider 的第一个模型（可能是数据库配置里过期的模型名）。
    const fallback = models[0];
    if (!fallback) {
      throw new Error(`provider「${choice.providerId}」下没有可用模型。`);
    }
    console.warn(
      `[agent/pi] 配置的模型「${choice.modelId}」不存在，回落到「${fallback.id}」。` +
      "去「设置 → AI 模型」重新选择。",
    );
    return { modelRuntime, model: fallback, providerId: choice.providerId, modelId: fallback.id };
  }

  console.info(`[agent/pi] 模型 ${choice.providerId}/${model.id}（凭据来源：${source}${requested ? "，调用方指定" : ""}）`);
  return { modelRuntime, model, providerId: choice.providerId, modelId: model.id };
}

/** 诊断信息：给设置页与启动自检用。 */
export async function piDiagnostics(): Promise<{
  ok: boolean;
  providerId?: string;
  modelId?: string;
  source?: string;
  error?: string;
}> {
  try {
    const { choice, source } = await resolveModelChoice();
    const runtime = await ModelRuntime.create();
    const models = runtime.getModels(choice.providerId) ?? [];
    const found = models.some((entry) => entry.id === choice.modelId);
    return {
      ok: found,
      providerId: choice.providerId,
      modelId: choice.modelId,
      source,
      ...(found ? {} : { error: `模型 ${choice.modelId} 不在 ${choice.providerId} 的列表里` }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
