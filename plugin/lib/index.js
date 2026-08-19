/**
 * dsh-feishu-bridge — 飞书远程助手桥接插件
 *
 * DSH Web 启动时，本插件自动拉起 feishu_bridge.py（Python 桥接进程），
 * 通过飞书长连接接收消息并转发给本机 DSH 的 /api RPC，再把回复发回飞书。
 *
 * 配置通过 profile 的 cordis.patch.yml 注入（见 README）：
 *   - insert:
 *       - id: feishu-bridge
 *         name: 'dsh-feishu-bridge'
 *         config: { ... }
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/** 默认桥接目录：本插件包（plugin/）的上一级目录，即 feishu_bridge.py 所在处。 */
const DEFAULT_BRIDGE_DIR = fileURLToPath(new URL("..", import.meta.url));

export const name = "feishu-bridge";
export const description = "飞书远程助手桥接：随 DSH 启动自动连接飞书";

export const inject = [];

export const Config = z.object({
  /** feishu_bridge.py 所在目录（默认取插件上一级目录）。 */
  bridgeDir: z.string().default(DEFAULT_BRIDGE_DIR),
  /** 启动桥接用的 Python 解释器。 */
  python: z.string().default("python"),
  /** 飞书自建应用 App ID。 */
  feishuAppId: z.string().default(""),
  /** 飞书自建应用 App Secret。 */
  feishuAppSecret: z.string().default(""),
  /** 飞书域名：feishu（国内）或 lark（国际版）。 */
  feishuDomain: z.string().default("feishu"),
  /** 本机 DSH Web 地址。 */
  dshBaseUrl: z.string().default("http://127.0.0.1:52199"),
  /** AI 工作目录（新建会话时使用），留空则用 DSH 默认。 */
  dshCwd: z.string().default(""),
  /** 轮询 DSH 回复的间隔（秒）。 */
  pollIntervalSeconds: z.number().default(2),
  /** 单轮任务超时（秒）。 */
  turnTimeoutSeconds: z.number().default(600),
  /** 长回复分段长度（字符）。 */
  replyChunkChars: z.number().default(8000),
  /** 桥接进程异常退出后的重启间隔（毫秒）。配置错误（exit 2）不重启。 */
  respawnDelayMs: z.number().default(5000),
});

/**
 * @param ctx - Cordis 插件上下文。
 * @param config - 上述配置。
 */
export function apply(ctx, config) {
  const script = join(config.bridgeDir, "feishu_bridge.py");
  if (!existsSync(script)) {
    ctx.logger.warn(`feishu-bridge: 未找到 ${script}，请检查 bridgeDir 配置`);
    return;
  }
  if (!config.feishuAppId || !config.feishuAppSecret) {
    ctx.logger.warn("feishu-bridge: 缺少 feishuAppId / feishuAppSecret 配置，桥接未启动");
    return;
  }

  const env = {
    ...process.env,
    FEISHU_APP_ID: config.feishuAppId,
    FEISHU_APP_SECRET: config.feishuAppSecret,
    FEISHU_DOMAIN: config.feishuDomain,
    DSH_BASE_URL: config.dshBaseUrl,
    DSH_POLL_INTERVAL: String(config.pollIntervalSeconds),
    DSH_TURN_TIMEOUT: String(config.turnTimeoutSeconds),
    DSH_REPLY_CHUNK_CHARS: String(config.replyChunkChars),
  };
  if (config.dshCwd) env.DSH_CWD = config.dshCwd;

  let child = null;
  let timer = null;

  const scheduleRestart = (reason) => {
    child = null;
    ctx.logger.warn(`feishu-bridge: ${reason}，${config.respawnDelayMs / 1000}s 后重启`);
    timer = setTimeout(start, config.respawnDelayMs);
  };

  const start = () => {
    if (child) return;
    ctx.logger.info(`feishu-bridge: 启动桥接进程 python ${script}`);
    child = spawn(config.python, [script], {
      cwd: config.bridgeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) ctx.logger.info(`[feishu-bridge] ${line}`);
      }
    });
    child.stderr.on("data", (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) ctx.logger.warn(`[feishu-bridge] ${line}`);
      }
    });
    child.on("error", (err) => {
      scheduleRestart(`桥接进程启动失败：${err.message}`);
    });
    child.on("exit", (code, signal) => {
      // 配置错误（exit 2）说明需要人工处理，不自动重启
      if (code === 2) {
        child = null;
        ctx.logger.warn("feishu-bridge: 桥接配置错误（exit 2），停止自动重启，请检查配置");
        return;
      }
      scheduleRestart(`桥接进程退出 code=${code} signal=${signal}`);
    });
  };

  start();

  ctx.on("dispose", () => {
    if (timer) clearTimeout(timer);
    if (child) {
      child.kill();
      child = null;
    }
    ctx.logger.info("feishu-bridge: 插件卸载，桥接进程已停止");
  });
}
