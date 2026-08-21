/**
 * dsh-feishu-bridge — 客户端面（浏览器 bundle，v0.2.1）
 *
 * 提供两个 UI 入口：
 *   1. 侧边栏底部“设置”旁的“飞书”按钮（slot: sidebar.footer.action）：
 *      显示桥接状态小圆点；点击后**在 DSH 内打开飞书对话页面**
 *      （与网页聊天相同的对话页，内容就是飞书上的交流），不跳转飞书。
 *   2. 设置 → 插件 页的“飞书对话”卡片（slot: settings.plugin.item）：
 *      运行状态、工作区、飞书会话、启动/停止、打开对话页面、最近日志。
 *
 * 打开会话的优先级：
 *   a. 服务端 /status 返回的 sessionId（飞书聊天 ↔ DSH 会话 精确映射）；
 *   b. 会话列表里 cwd === 工作区 的最新非空白会话（找不到映射时兜底）；
 *   c. 都没有 → 在工作区新建一个会话并打开。
 *
 * 与服务端面的通信走同源 HTTP 路由：
 *   GET  /feishu-bridge/status   POST /feishu-bridge/start|stop
 *
 * 打包格式与 @deepseek-ai/dsh-client-ui-aqua 相同：window.__ModuleLoader__.load。
 * 外部依赖只使用 react（服务经 cordis inject 注入：['slots', 'sessions']）。
 */
window.__ModuleLoader__.load({
	id: "dsh-feishu-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		var React = require("react");

		// ── 样式注入（随 bundle 加载，卸载时由 HMR 驱动器清理） ──
		(function () {
			if (typeof document === "undefined") return;
			var key = "dsh-feishu-bridge/ui";
			if (document.querySelector('style[data-plugin-css="' + key + '"]')) return;
			var tag = document.createElement("style");
			tag.dataset.pluginCss = key;
			tag.textContent = [
				".fb-card{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:16px}",
				".fb-card-head{display:flex;justify-content:space-between;align-items:center;gap:16px}",
				".fb-card-text{display:flex;flex-direction:column;gap:2px;min-width:0}",
				".fb-card-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px}",
				".fb-card-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
				".fb-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0 10px;height:28px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);flex:none}",
				".fb-rows{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);min-width:0}",
				".fb-row{display:flex;gap:8px;align-items:baseline;min-width:0}",
				".fb-row-label{flex:none;color:var(--dsw-alias-label-tertiary)}",
				".fb-row-value{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".fb-log{max-height:96px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all}",
				".fb-log-time{opacity:.55;margin-right:6px}",
				".fb-btns{display:flex;gap:8px;flex-wrap:wrap}",
				".fb-btn{display:inline-flex;align-items:center;gap:6px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer}",
				".fb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".fb-btn[disabled]{opacity:.5;cursor:default}",
				".fb-btn-primary{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);border-color:transparent}",
				".fb-btn-primary:hover{background:var(--dsw-alias-state-business-tertiary)}",
				".fb-btn-danger:hover{color:var(--dsw-alias-state-danger);border-color:var(--dsw-alias-state-danger)}",
				".fb-entry{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;cursor:pointer;position:relative;text-decoration:none}",
				".fb-entry:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".fb-entry-wide{width:100%;justify-content:flex-start;padding:0 12px}",
				".fb-icon{display:inline-flex;align-items:center;justify-content:center;flex:none}",
				".fb-label{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);flex:1;text-align:left}",
				".fb-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-quaternary)}",
				".fb-dot-on{background:#34c759;box-shadow:0 0 0 3px rgba(52,199,89,.18)}",
				".fb-dot-off{background:#ff3b30;box-shadow:0 0 0 3px rgba(255,59,48,.18)}",
				".fb-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}",
			].join("");
			document.head.appendChild(tag);
		})();

		// ── 与服务端面的通信 ──
		function fetchStatus() {
			return fetch("/feishu-bridge/status", { cache: "no-store" }).then(function (resp) {
				if (!resp.ok) throw new Error("HTTP " + resp.status);
				return resp.json();
			});
		}
		function post(path) {
			return fetch(path, { method: "POST" }).then(function (resp) {
				if (!resp.ok) throw new Error("HTTP " + resp.status);
				return resp.json();
			});
		}

		function useStatus(pollMs) {
			var pair = React.useState({ loading: true, data: null, error: null });
			var state = pair[0];
			var setState = pair[1];
			React.useEffect(function () {
				var alive = true;
				var tick = function () {
					fetchStatus().then(function (data) {
						if (alive) setState({ loading: false, data: data, error: null });
					}, function (err) {
						if (alive) setState(function (s) {
							return { loading: false, data: s.data, error: (err && err.message) || String(err) };
						});
					});
				};
				tick();
				var id = setInterval(tick, pollMs);
				return function () {
					alive = false;
					clearInterval(id);
				};
			}, [pollMs]);
			return state;
		}

		function useBusy() {
			var pair = React.useState(false);
			var run = function (fn) {
				if (pair[0]) return Promise.resolve();
				pair[1](true);
				return Promise.resolve().then(fn).finally(function () {
					pair[1](false);
				});
			};
			return [pair[0], run];
		}

		// ── 会话解析：把“飞书对话”落到一个 DSH 会话页面上 ──
		function normPath(p) {
			return String(p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
		}
		/**
		 * @param statusData - /status 返回（含 sessionId / workspace）
		 * @param list - useSessions 快照（{ current, ids, byId }）
		 */
		function resolveSessionId(statusData, list) {
			if (statusData && statusData.sessionId) return statusData.sessionId;
			var ws = statusData && statusData.workspace;
			if (ws && list) {
				var ids = list.ids || [];
				var best = null;
				for (var i = 0; i < ids.length; i++) {
					var s = list.byId[ids[i]];
					if (s && s.cwd && !s.blank && normPath(s.cwd) === normPath(ws)) {
						if (!best || (s.updatedAt || 0) > (best.updatedAt || 0)) best = s;
					}
				}
				if (best) return best.sessionId;
			}
			return null;
		}

		// ── 图标：纸飞机（飞书对话） ──
		var planeSvg = React.createElement(
			"svg",
			{ viewBox: "0 0 24 24", width: 16, height: 16, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
			React.createElement("path", { d: "M22 2 11 13" }),
			React.createElement("path", { d: "M22 2 15 22l-4-9-9-4 20-7z" })
		);

		function dotClass(status) {
			var data = status.data;
			// 绿 = 正常接通飞书；红 = 异常（未连接 / 桥接未运行 / 状态不可读）
			if (data && data.connected) return "fb-dot fb-dot-on";
			return "fb-dot fb-dot-off";
		}

		/**
		 * 打开飞书对话页面：启动桥接（保飞书在线）→ 解析会话 → 在 DSH 内打开。
		 */
		function openConversation(busyRun, status, listProvider, openSession, createSession) {
			return busyRun(function () {
				return post("/feishu-bridge/start").then(function (data) {
					var listSnapshot = listProvider.getSnapshot();
					var sid = resolveSessionId(data, listSnapshot);
					if (!sid) sid = resolveSessionId(status.data, listSnapshot);
					if (sid) {
						openSession(sid);
						return;
					}
					var ws = (data && data.workspace) || (status.data && status.data.workspace);
					if (ws && createSession) {
						return createSession(ws).then(function (res) {
							var v = res && res.result && res.result.value;
							if (v && v.sessionId) openSession(v.sessionId);
						});
					}
				});
			}).catch(function () { /* 桥接路由不可用时静默 */ });
		}

		// ── 入口 1：侧边栏底部“飞书”按钮 ──
		function FeishuFooterAction(props) {
			var wide = props.wide;
			var status = useStatus(3000);
			var busy = useBusy();
			var list = props.useSessions ? props.useSessions(function (s) { return s; }) : null;
			var onClick = function () {
				openConversation(busy[1], status, { getSnapshot: function () { return list; } }, props.openSession, props.createSession);
			};
			var title = (status.data && status.data.connected) ? "飞书已接通 · 打开对话页面" : "飞书未连接（异常）· 打开对话页面";
			return React.createElement(
				"button",
				{ type: "button", className: wide ? "fb-entry fb-entry-wide" : "fb-entry", onClick: onClick, title: title, "aria-label": title },
				React.createElement("span", { className: "fb-icon" }, planeSvg),
				wide ? React.createElement("span", { className: "fb-label" }, "飞书") : null,
				React.createElement("span", { className: dotClass(status) })
			);
		}

		// ── 入口 2：设置 → 插件 页的“飞书对话”卡片 ──
		function FeishuSettingsCard(props) {
			var status = useStatus(3000);
			var busy = useBusy();
			var list = props.useSessions ? props.useSessions(function (s) { return s; }) : null;
			var data = status.data;
			var running = !!(data && data.running);
			var connected = !!(data && data.connected);
			var workspace = (data && data.workspace) || "";
			var lastLog = (data && data.lastLog) || [];
			var sessionId = data ? resolveSessionId(data, list) : null;
			var chipText = connected ? "已连接飞书" : "未连接（异常）";
			var dotCls = connected ? "fb-dot fb-dot-on" : "fb-dot fb-dot-off";

			var onToggle = function () {
				busy[1](function () {
					return post(running ? "/feishu-bridge/stop" : "/feishu-bridge/start");
				}).catch(function () { /* 静默 */ });
			};
			var onOpen = function () {
				openConversation(busy[1], status, { getSnapshot: function () { return list; } }, props.openSession, props.createSession);
			};

			var logNodes = lastLog.map(function (entry, i) {
				var time = new Date(entry.time).toLocaleTimeString();
				return React.createElement(
					"div",
					{ key: i },
					React.createElement("span", { className: "fb-log-time" }, time),
					entry.line
				);
			});

			return React.createElement(
				"div",
				{ className: "fb-card" },
				React.createElement(
					"div",
					{ className: "fb-card-head" },
					React.createElement(
						"div",
						{ className: "fb-card-text" },
						React.createElement("div", { className: "fb-card-title" }, "飞书对话"),
						React.createElement("div", { className: "fb-card-desc" }, "飞书上的交流在 DSH 里同步成一个对话页面，点下面的按钮直接打开")
					),
					React.createElement("span", { className: "fb-chip" }, React.createElement("span", { className: dotCls }), chipText)
				),
				React.createElement(
					"div",
					{ className: "fb-rows" },
					React.createElement(
						"div",
						{ className: "fb-row" },
						React.createElement("span", { className: "fb-row-label" }, "工作区"),
						React.createElement("span", { className: "fb-row-value", title: workspace }, workspace || "（DSH 默认）")
					),
					data
						? React.createElement(
							"div",
							{ className: "fb-row" },
							React.createElement("span", { className: "fb-row-label" }, "桥接"),
							React.createElement("span", { className: "fb-row-value" }, "端口 " + data.port + (data.pid ? " · PID " + data.pid : ""))
						)
						: null,
					React.createElement(
						"div",
						{ className: "fb-row" },
						React.createElement("span", { className: "fb-row-label" }, "飞书会话"),
						React.createElement("span", { className: "fb-row-value", title: sessionId || "" }, sessionId ? sessionId.slice(0, 36) : "（暂无映射，飞书里发条消息后自动关联）")
					)
				),
				React.createElement(
					"div",
					{ className: "fb-btns" },
					React.createElement(
						"button",
						{ type: "button", className: "fb-btn fb-btn-primary", disabled: busy[0], onClick: onOpen },
						"打开对话页面"
					),
					React.createElement(
						"button",
						{ type: "button", className: "fb-btn " + (running ? "fb-btn-danger" : ""), disabled: busy[0], onClick: onToggle },
						running ? "停止桥接" : "启动桥接"
					)
				),
				status.error
					? React.createElement("div", { className: "fb-hint" }, "无法读取桥接状态：" + status.error)
					: null,
				logNodes.length
					? React.createElement("div", { className: "fb-log" }, logNodes)
					: null
			);
		}

		// ── 插件主体 ──
		exports.name = "feishu-bridge";
		exports.inject = ["slots", "sessions"];
		exports.apply = function (ctx) {
			var face = function () {
				return {
					openSession: function (id) { ctx.sessions.open(id); },
					createSession: function (cwd) { return ctx.sessions.create({ cwd: cwd }); },
				};
			};
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "feishu-bridge",
					order: 100,
					label: "飞书",
					inject: face,
				}, FeishuFooterAction);
			});
			ctx.slots.inject("settings.plugin.item", function () {
				return ctx.slots.register({
					name: "settings.plugin.item",
					id: "feishu-bridge",
					order: 100,
					label: "飞书对话",
					inject: face,
				}, FeishuSettingsCard);
			});
		};

		return module.exports;
	},
});
