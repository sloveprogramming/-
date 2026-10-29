import "server-only";

import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Agent 用的 ResourceLoader：用官方实现，但**关掉一切文件发现**。
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
 * | `noExtensions` | 不加载任何扩展（codemode / MCP 都不需要） |
 * | `noPromptTemplates` | 不扫提示词模板 |
 * | `noThemes` | 不扫主题 |
 *
 * 只保留 `systemPrompt`。这样环境是确定的、可复现的，也不会因为磁盘上有文件
 * 而改变 Agent 行为（多租户下那等于跨租户注入）。
 */
export function createAgentResourceLoader(systemPrompt: string): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    settingsManager: SettingsManager.create(process.cwd(), getAgentDir()),
    systemPrompt,
    noContextFiles: true,
    noSkills: true,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });
}
