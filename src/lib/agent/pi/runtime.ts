import "server-only";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getAiConnection, getAiCredentials } from "@/lib/ai/connections";
import { getByokSettings } from "@/lib/ai/byok";

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
    // 数据库读不到就走环境变量；这里的失败不该让整个 Agent 挂掉。
    console.warn("[agent/pi] 读取数据库凭据失败，尝试环境变量：", error instanceof Error ? error.message : error);
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
 */
export async function createPiRuntime(): Promise<PiRuntimeHandle> {
  const { choice, apiKey, source } = await resolveModelChoice();
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
  const model = models.find((entry) => entry.id === choice.modelId) ?? models[0];
  if (!model) {
    throw new Error(
      `provider「${choice.providerId}」下没有模型「${choice.modelId}」。可选：${models.map((m) => m.id).join("、") || "（无）"}`,
    );
  }

  console.info(`[agent/pi] 模型 ${choice.providerId}/${model.id}（凭据来源：${source}）`);
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
