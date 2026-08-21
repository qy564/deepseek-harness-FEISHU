/**
 * dsh-feishu-bridge — 飞书远程助手桥接插件（v0.2）
 *
 * 服务端面（本文件）：
 *   - DSH Web 启动时自动拉起 feishu_bridge.py（Python 桥接进程）；
 *   - 自动探测当前 DSH Web 的实际端口（ctx.webServer.port），
 *     不再依赖写死的 dshBaseUrl（DSH 每次启动端口都可能变化）；
 *   - 在 webServer 上注册三个控制/状态路由，供浏览器同源调用：
 *       GET  /feishu-bridge/status  桥接运行状态 + 最近日志
 *       POST /feishu-bridge/start   启动桥接（若未运行）
 *       POST /feishu-bridge/stop    停止桥接（并抑制自动重启）
 *   - 客户端面见 lib/client.js：侧边栏“飞书”入口 + 设置页状态卡片。
 *
 * 配置通过 profile 的 cordis.patch.yml 注入（见 README）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

/** 默认桥接目录：本插件包（plugin/）的上一级目录，即 feishu_bridge.py 所在处。 */
const DEFAULT_BRIDGE_DIR = fileURLToPath(new URL("..", import.meta.url));

export const name = "feishu-bridge";
export const description = "飞书远程助手桥接：随 DSH 启动自动连接飞书，侧边栏提供对话入口";

export const inject = ["webServer"];

export const Config = z.object({
  /** feishu_bridge.py 所在目录。 */
  bridgeDir: z.string().default(DEFAULT_BRIDGE_DIR),
  /** 启动桥接用的 Python 解释器。 */
  python: z.string().default("python"),
  /** 飞书自建应用 App ID。 */
  feishuAppId: z.string().default(""),
  /** 飞书自建应用 App Secret。 */
  feishuAppSecret: z.string().default(""),
  /** 飞书域名：feishu（国内）或 lark（国际版）。 */
  feishuDomain: z.string().default("feishu"),
  /**
   * 桥接连接的本机 DSH Web 地址。
   * 留空（默认）时自动使用当前 DSH Web 的实际端口，端口变化无需改配置；
   * 只有特殊部署才需要显式覆盖。
   */
  dshBaseUrl: z.string().default(""),
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
  /**
   * 飞书对话的打开链接（“飞书”入口点击后跳转）。
   * 留空时自动推导：优先用 state.json 里的聊天（chat）id 生成 applink，
   * 否则退回飞书开放平台首页。
   */
  openUrl: z.string().default(""),
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

  // ── 诊断：插件自己的文件日志（宿主 console 在桌面模式下不可见） ──
  const pluginLog = join(config.bridgeDir, "plugin.log");
  const logToFile = (line) => {
    try {
      appendFileSync(pluginLog, `[${new Date().toISOString()}] pid=${process.pid} ${line}\n`);
    } catch { /* 忽略 */ }
  };

  // ── 关键修复：DSH Web 每次启动端口都可能变化，这里直接读取实际端口 ──
  const livePort = ctx.webServer?.port ?? null;
  let baseUrl = config.dshBaseUrl || (livePort ? `http://127.0.0.1:${livePort}` : "");
  let localPort = null;
  let shim = null;
  logToFile(`apply: livePort=${livePort} baseUrl="${baseUrl}" execPath=${process.execPath}`);

  // 桌面模式：宿主把 HTTP 载体换成了 IPC（desktop-carrier 的 port=0 只是占位，
  // 不监听任何端口），所以 webServer.port 拿不到可用地址。此时在宿主进程内开
  // 一个 127.0.0.1 的 HTTP shim，把 /api RPC 原样转发给 desktopBridge 服务
  // （与浏览器 IPC 共用同一个 /api 处理器），Python 桥接进程无需任何改动。
  // 注意：不能依赖插件 ctx 的 ready 事件（本组合下不可靠），直接在 apply 时
  // 创建 shim；desktopBridge 由桌面覆盖层稍后挂载，请求处理器按需惰性解析，
  // 桥接自身的 12 次重试正好覆盖启动窗口。
  if (!baseUrl) {
    shim = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        const host = String(req.headers.host ?? "127.0.0.1");
        const request = new Request(new URL(req.url ?? "/", `http://${host}`), {
          method: req.method,
          headers: req.headers,
          body: body.length > 0 ? body : undefined,
        });
        const bridgeNow = ctx.get("desktopBridge");
        if (!bridgeNow?.fetch) {
          res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
          res.end("desktopBridge not ready");
          return;
        }
        const response = await bridgeNow.fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        const out = response.body === null ? null : Buffer.from(await response.arrayBuffer());
        res.end(out);
      } catch (err) {
        ctx.logger.warn("feishu-bridge: shim 转发失败", err);
        logToFile(`shim request failed: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("feishu-bridge shim error");
        } else {
          res.destroy();
        }
      }
    });
    shim.on("error", (err) => {
      ctx.logger.warn("feishu-bridge: shim error:", err);
      logToFile(`shim event error: ${err.message}`);
    });
    shim.on("close", () => {
      ctx.logger.warn("feishu-bridge: shim CLOSED");
      logToFile(`shim event CLOSED (was ${localPort})`);
    });
    shim.on("listening", () => {
      logToFile(`shim event listening ${JSON.stringify(shim.address())}`);
    });
    shim.listen(0, "127.0.0.1", () => {
      localPort = shim.address().port;
      baseUrl = `http://127.0.0.1:${localPort}`;
      try { writeFileSync(join(config.bridgeDir, "shim-port.txt"), String(localPort)); } catch { /* 忽略 */ }
      logToFile(`shim listening on ${localPort}; baseUrl=${baseUrl}`);

      // 看门狗：5 秒一次，检查监听状态 + 进程内自测。shim 意外关闭时重新
      // 监听（新端口）并重启桥接进程以刷新环境变量。
      const watchdog = setInterval(async () => {
        if (!shim) return;
        if (!shim.listening) {
          logToFile(`watchdog: shim NOT listening (was ${localPort})`);
          ctx.logger.warn(`feishu-bridge: watchdog 发现 shim 未在监听（was ${localPort}）`);
          try {
            shim.listen(0, "127.0.0.1", () => {
              localPort = shim.address().port;
              baseUrl = `http://127.0.0.1:${localPort}`;
              env.DSH_BASE_URL = baseUrl;
              logToFile(`watchdog: shim re-listened → ${localPort}; 重启桥接以刷新端口`);
              if (child) { child.kill(); child = null; }
            });
          } catch (err) {
            logToFile(`watchdog: re-listen failed: ${err.message}`);
          }
          return;
        }
        // 内部自测：从宿主进程内访问 shim 的 /api（区分“shim 没监听”
        // 与“外部连不上但内部正常”）
        try {
          const res = await fetch(`http://127.0.0.1:${localPort}/api/session.list`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              host: `127.0.0.1:${localPort}`,
            },
            body: JSON.stringify({ rpcId: "wd-test", method: "session.list", payload: {} }),
          });
          const text = await res.text();
          logToFile(`watchdog self-test: HTTP ${res.status} ${String(text).slice(0, 120)}`);
        } catch (err) {
          logToFile(`watchdog self-test FAILED from inside: ${err.message}`);
        }
      }, 5000);
      ctx.on("dispose", () => clearInterval(watchdog));

      logToFile(`bridge will use ${baseUrl}; spawning...`);
      start();
      logToFile("start() called");
    });
  }

  const env = {
    ...process.env,
    FEISHU_APP_ID: config.feishuAppId,
    FEISHU_APP_SECRET: config.feishuAppSecret,
    FEISHU_DOMAIN: config.feishuDomain,
    DSH_BASE_URL: baseUrl,
    DSH_POLL_INTERVAL: String(config.pollIntervalSeconds),
    DSH_TURN_TIMEOUT: String(config.turnTimeoutSeconds),
    DSH_REPLY_CHUNK_CHARS: String(config.replyChunkChars),
  };
  if (config.dshCwd) env.DSH_CWD = config.dshCwd;

  let child = null;
  let timer = null;
  let manualStop = false;
  let connected = false;
  let startedAt = null;
  /** 最近日志环形缓冲（供 UI 状态卡片展示）。 */
  const logRing = [];

  const pushLog = (level, line) => {
    const text = String(line).replace(/\s+$/, "");
    if (!text) return;
    logRing.push({ time: Date.now(), level, line: text });
    if (logRing.length > 80) logRing.shift();
    // 飞书长连接成功建立时，stdout 会打印这一行
    if (text.includes("connected to wss://")) connected = true;
  };

  const stopChild = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (child) {
      child.kill();
      child = null;
    }
    connected = false;
  };

  const start = () => {
    if (child) return;
    manualStop = false;
    connected = false;
    startedAt = new Date().toISOString();
    // 桌面模式下 baseUrl 在 ready 后才确定，spawn 前必须刷新
    env.DSH_BASE_URL = baseUrl;
    pushLog("info", `启动桥接进程 ${config.python} ${script}（DSH=${baseUrl}）`);
    ctx.logger.info(`feishu-bridge: 启动桥接进程 ${config.python} ${script}`);
    const proc = spawn(config.python, [script], {
      cwd: config.bridgeDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child = proc;
    proc.stdout.on("data", (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) {
          pushLog("info", line);
          ctx.logger.info(`[feishu-bridge] ${line}`);
        }
      }
    });
    proc.stderr.on("data", (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) {
          pushLog("warn", line);
          ctx.logger.warn(`[feishu-bridge] ${line}`);
        }
      }
    });
    proc.on("error", (err) => {
      if (child !== proc) return;
      child = null;
      connected = false;
      pushLog("error", `桥接进程启动失败：${err.message}`);
      scheduleRestart(`桥接进程启动失败：${err.message}`);
    });
    proc.on("exit", (code, signal) => {
      if (child !== proc) return;
      child = null;
      connected = false;
      if (manualStop) {
        pushLog("info", "桥接已手动停止");
        return;
      }
      // 配置错误（exit 2）说明需要人工处理，不自动重启
      if (code === 2) {
        pushLog("error", "桥接配置错误（exit 2），停止自动重启，请检查配置");
        ctx.logger.warn("feishu-bridge: 桥接配置错误（exit 2），停止自动重启，请检查配置");
        return;
      }
      scheduleRestart(`桥接进程退出 code=${code} signal=${signal}`);
    });
  };

  const scheduleRestart = (reason) => {
    pushLog("warn", `${reason}，${config.respawnDelayMs / 1000}s 后重启`);
    ctx.logger.warn(`feishu-bridge: ${reason}，${config.respawnDelayMs / 1000}s 后重启`);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      start();
    }, config.respawnDelayMs);
  };

  const stop = () => {
    manualStop = true;
    stopChild();
    pushLog("info", "桥接已停止（手动）");
    ctx.logger.info("feishu-bridge: 桥接已停止（手动）");
  };

  // ── 飞书对话打开链接：优先用 state.json 里的聊天 id 生成 applink ──
  const resolveOpenUrl = () => {
    if (config.openUrl) return config.openUrl;
    const intl = String(config.feishuDomain).toLowerCase().includes("lark");
    const host = intl ? "applink.larksuite.com" : "applink.feishu.cn";
    try {
      const statePath = join(config.bridgeDir, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        const chatId = Object.keys(state)[0];
        if (chatId) return `https://${host}/client/chat/open?chatId=${encodeURIComponent(chatId)}`;
      }
    } catch {
      // 忽略：退回开放平台首页
    }
    return intl ? "https://open.larksuite.com" : "https://open.feishu.cn";
  };

  // ── 飞书聊天 → DSH 会话 映射（state.json，供 UI 直接打开对话页面） ──
  const readSessionMap = () => {
    try {
      const statePath = join(config.bridgeDir, "state.json");
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        return Object.entries(state).map(([chatId, sessionId]) => ({ chatId, sessionId }));
      }
    } catch {
      // 忽略：映射尚未建立（等下一次飞书消息后自动生成）
    }
    return [];
  };

  const status = () => {
    const sessions = readSessionMap();
    return {
      ok: true,
      running: child !== null,
      connected,
      pid: child?.pid ?? null,
      port: livePort || localPort,
      baseUrl,
      workspace: config.dshCwd || null,
      startedAt,
      openUrl: resolveOpenUrl(),
      // 当前飞书聊天对应的 DSH 会话（UI 用它打开对话页面）
      sessionId: sessions.length ? sessions[0].sessionId : null,
      sessions,
      lastLog: logRing.slice(-25),
    };
  };

  const json = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const onlyPost = (req, res, handler) => {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    handler(req, res);
  };

  const disposers = [];
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/feishu-bridge/status",
    handler: (req, res) => json(res, 200, status()),
  }));
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/feishu-bridge/start",
    handler: (req, res) => onlyPost(req, res, () => {
      start();
      json(res, 200, status());
    }),
  }));
  disposers.push(ctx.webServer.register({
    kind: "exact",
    path: "/feishu-bridge/stop",
    handler: (req, res) => onlyPost(req, res, () => {
      stop();
      json(res, 200, status());
    }),
  }));

  ctx.logger.info(`feishu-bridge: 已注册控制路由（/feishu-bridge/status|start|stop，port=${livePort}）`);

  if (baseUrl) start();

  ctx.on("dispose", () => {
    stopChild();
    if (shim) shim.close();
    for (const dispose of disposers) dispose();
    ctx.logger.info("feishu-bridge: 插件卸载，桥接进程已停止");
  });
}
