import "server-only";

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * 把 Pi 的配置目录重定向到**进程私有**的位置，避免写用户主目录。
 *
 * ## 为什么必须这么做
 *
 * 实测发现 Pi 会往 `~/.pi/agent/` 写两个文件：
 *
 * ```
 * auth.json          （SettingsManager 写的）
 * models-store.json  （ModelRuntime.create() 默认用 FileModelsStore）
 * ```
 *
 * 单机单租户时这没影响。但这个项目是**多租户 + 可能多实例**：
 *
 * - 同一台机器上跑两个实例 → 两个租户共享同一个 `auth.json`
 * - 容器化部署 → 用户主目录没有持久卷，重启就丢
 * - key 落到磁盘 → 违反"凭据只在内存里"的设计
 *
 * ## 解法
 *
 * Pi 的路径函数支持环境变量覆盖（源码里 `ENV_AGENT_DIR =
 * PI_CODING_AGENT_DIR`）。所以在进程启动时把它指到一个临时目录：
 *
 * ```
 * <os tmpdir>/agent-sdr-pi-<pid>/
 * ```
 *
 * 带来两个好处：
 * - **每次进程启动都是新的空目录**，不会读到上一次运行的残留
 * - **不同进程天然隔离**（目录名带 pid）
 *
 * 我们还额外在 ModelRuntime 里传空凭据存储，让 key 连这个目录都不写
 * （见 runtime.ts）。
 */

let initialized = false;

/** 确保 Pi 的 agent 目录已重定向。幂等，可以重复调用。 */
export function ensurePiAgentDir(): string {
  const existing = process.env.PI_CODING_AGENT_DIR?.trim();
  if (existing) {
    // 调用方（或者运维）已经显式指定了，尊重它。
    if (!initialized) {
      mkdirSync(existing, { recursive: true });
      initialized = true;
    }
    return existing;
  }

  // 进程私有目录：带 pid，多实例共存时互不影响。
  const dir = join(tmpdir(), `agent-sdr-pi-${process.pid}`);
  if (!initialized || !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = dir;
    initialized = true;
    console.info(`[agent/pi] 配置目录已重定向：${dir}`);
  }
  return dir;
}

/** 当前 Pi 目录（供诊断页展示）。 */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || "(尚未初始化)";
}
