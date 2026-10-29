import "server-only";

import { DefaultResourceLoader, getAgentDir, SettingsManager, type InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Agent 用的 ResourceLoader：官方实现 + 关掉一切文件发现，并挂上我们的内联扩展。
 *
 * ## 为什么不能自己实现 ResourceLoader
 *
 * 一开始写了个极简 loader，只实现 `getSystemPrompt` 等方法，结果 Pi 内部崩在
 * `bindCore`：它期望 `getExtensions()` 的返回值里带一个运行时的 `runtime`
 * 对象（`{ flagValues, pendingProviderRegistrations, ... }`）。那是内部协议，
 * 自己拼不出来。
 *
 * 所以用官方 `DefaultResourceLoader`，但把所有"扫磁盘"的开关关掉：
 *
 * | 开关 | 关掉的原因 |
 * |---|---|
 * | `noContextFiles` | 不读工作目录的 AGENTS.md —— 服务端不该被当前目录影响 |
 * | `noSkills` | 不扫 skills 目录 |
 * | `noPromptTemplates` | 不扫提示词模板 |
 * | `noThemes` | 不扫主题 |
 *
 * 只保留 `systemPrompt`。这样环境是确定的、可复现的，也不会因为磁盘上有文件
 * 而改变 Agent 行为（多租户下那等于跨租户注入）。
 *
 * ## 关于 noExtensions
 *
 * 注意 `noExtensions` 会**连我们的内联扩展一起关掉**（实测），而工具调用上限
 * 正是靠内联扩展的 `tool_call` hook 实现的。所以这里**不设** `noExtensions`，
 * 改为只传入我们自己的 `extensionFactories`——没有额外路径，等于只加载这一个。
 */
/**
 * 创建 loader 并**强制加载内联扩展**。
 *
 * 关键：`DefaultResourceLoader` 构造时把 `extensionsResult` 初始化成空数组，
 * 真正加载要调用 `reload()`。不调的话扩展数是 0 —— 表现就是「工具调用上限
 * 完全不生效」（实测：上限设 2，实际跑了 8 次）。
 *
 * 所以这里是 async 的：构造完立刻 reload，调用方 await 后才拿到可用 loader。
 */
export async function createAgentResourceLoader(
  systemPrompt: string,
  extensionFactories: readonly InlineExtension[] = [],
): Promise<DefaultResourceLoader> {
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.create(process.cwd(), getAgentDir()),
    systemPrompt,
    // 只加载我们自己传进来的内联扩展（目前就是"工具调用上限"那一个）。
    extensionFactories: [...extensionFactories],
    // 关掉文件发现。不开 noExtensions，否则会连上面的内联扩展一起关掉。
    noContextFiles: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  // 必须显式 reload：构造时 extensionsResult 是空数组。
  await loader.reload();
  return loader;
}
