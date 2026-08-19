#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DSH <-> 飞书 双向桥接器
========================

通过飞书开放平台"自建应用 + 长连接事件订阅"接收消息，转发给本机 DeepSeek
Harness Web（http://127.0.0.1:52199 的 /api RPC 协议），再把 AI 的回复发回
飞书聊天。

使用前：
  1. pip install -r requirements.txt
  2. 在飞书开放平台创建自建应用并配置（详见 README.md）
  3. 填写 config.json（App ID / App Secret）
  4. python feishu_bridge.py

支持命令：
  /new      开启新对话（新的 DSH 会话，之前的上下文不再保留）
  /cancel   取消当前正在进行的任务
  /status   查看当前会话状态

注意：
  * 群聊中只在机器人被 @ 时回复；单聊直接回复。
  * 桥接创建的 DSH 会话与网页 GUI 共用同一个 DSH 实例，但互相独立。
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent

# ---------------------------------------------------------------- 日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(BASE_DIR / "bridge.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("feishu-bridge")

FEISHU_CN = "https://open.feishu.cn"
LARK_INTL = "https://open.larksuite.com"


# ---------------------------------------------------------------- 配置
def load_config() -> dict:
    cfg_path = BASE_DIR / "config.json"
    if not cfg_path.exists():
        log.error("未找到 config.json，请先复制 config.example.json 并填写配置")
        sys.exit(2)
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    # 允许用环境变量覆盖（插件模式由 DSH 插件进程注入）
    for key, env in (
        ("feishu_app_id", "FEISHU_APP_ID"),
        ("feishu_app_secret", "FEISHU_APP_SECRET"),
        ("feishu_domain", "FEISHU_DOMAIN"),
        ("dsh_base_url", "DSH_BASE_URL"),
        ("dsh_cwd", "DSH_CWD"),
        ("poll_interval_seconds", "DSH_POLL_INTERVAL"),
        ("turn_timeout_seconds", "DSH_TURN_TIMEOUT"),
        ("reply_chunk_chars", "DSH_REPLY_CHUNK_CHARS"),
    ):
        if os.environ.get(env):
            cfg[key] = os.environ[env]
    # 数值型配置转成数字
    for key in ("poll_interval_seconds", "turn_timeout_seconds", "reply_chunk_chars"):
        try:
            cfg[key] = float(cfg.get(key, 0)) if key != "reply_chunk_chars" else int(cfg.get(key, 0))
        except (TypeError, ValueError):
            pass
    if not cfg.get("feishu_app_id") or not cfg.get("feishu_app_secret"):
        log.error("缺少 feishu_app_id / feishu_app_secret（config.json 或环境变量）")
        sys.exit(2)
    return cfg


def feishu_domain(cfg: dict) -> str:
    """把配置里的 domain 名映射为 SDK 可用的 URL。"""
    value = str(cfg.get("feishu_domain", "feishu")).lower()
    if value in ("lark", "larksuite", "international", LARK_INTL):
        return LARK_INTL
    return FEISHU_CN


# ---------------------------------------------------------------- DSH RPC 客户端
class DshClient:
    """DeepSeek Harness Web 的 /api RPC 客户端（与浏览器前端同一协议）。"""

    def __init__(self, base_url: str, poll_interval: float = 2.0,
                 turn_timeout: float = 600.0, history_page: int = 50):
        self.base_url = base_url.rstrip("/")
        self.poll_interval = poll_interval
        self.turn_timeout = turn_timeout
        self.history_page = history_page

    def rpc(self, method: str, payload: dict) -> dict:
        """调用一次 unary RPC，返回 result.value。"""
        message = {
            "type": "client-request",
            "rpcId": str(uuid.uuid4()),
            "method": method,
            "payload": payload,
        }
        resp = requests.post(
            f"{self.base_url}/api/{method}",
            json=message,
            timeout=30,
        )
        if resp.status_code == 403:
            raise RuntimeError(
                f"DSH 拒绝了请求（403，浏览器信任围栏）：请确认 DSH 以 "
                f"127.0.0.1 方式运行"
            )
        resp.raise_for_status()
        data = resp.json()
        if data.get("rpcId") != message["rpcId"]:
            raise RuntimeError("DSH 响应 rpcId 不匹配")
        result = data.get("result", {})
        if not result.get("ok"):
            err = result.get("error") or result
            raise DshRpcError(method, err)
        return result.get("value") or {}

    def ping(self) -> None:
        self.rpc("session.list", {})

    def create_session(self, cwd: str | None = None) -> str:
        payload = {"cwd": cwd} if cwd else {}
        value = self.rpc("session.create", payload)
        return value["sessionId"]

    def cancel(self, session_id: str) -> None:
        self.rpc("session.cancel", {"sessionId": session_id})

    def ask(self, session_id: str, text: str) -> str:
        """
        发送一条用户消息并等待本轮结束，返回 AI 的最终文本回复。
        """
        before = self.rpc("session.history", {
            "sessionId": session_id,
            "maxMessages": self.history_page,
        })
        before_seq = max(
            (e["event"]["seq"] for e in before.get("events", [])),
            default=-1,
        )
        self.rpc("session.prompt", {
            "sessionId": session_id,
            "mode": "queue",
            "content": [{"type": "text", "text": text}],
        })
        collected: list[str] = []
        seen = before_seq
        done = False
        reason = None
        deadline = time.monotonic() + self.turn_timeout
        while time.monotonic() < deadline:
            time.sleep(self.poll_interval)
            hist = self.rpc("session.history", {
                "sessionId": session_id,
                "maxMessages": self.history_page,
            })
            for entry in hist.get("events", []):
                ev = entry["event"]
                if ev["seq"] <= before_seq:
                    continue
                if ev["type"] == "assistant/message":
                    content = ev.get("data", {}).get("message", {}).get("content", [])
                    parts = [
                        b.get("text", "")
                        for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    ]
                    if parts and ev["seq"] > seen:
                        collected.append("".join(parts))
                        seen = ev["seq"]
                elif ev["type"] == "turn/end":
                    done = True
                    reason = ev.get("data", {}).get("reason")
            if done:
                break
        if not done:
            raise TimeoutError(f"等待 DSH 回复超时（{self.turn_timeout:.0f}s）")
        reply = "\n".join(collected).strip()
        if not reply:
            reply = "（AI 没有给出文字回复）"
        kind = (reason or {}).get("kind", "unknown")
        if kind != "completed":
            note = {
                "user": "本轮 AI 需要你进一步确认（可能提出了问题或需要批准）",
                "cancelled": "本轮已被取消",
                "interrupted": "本轮被中断",
                "max-tokens": "本轮达到输出上限被截断",
            }.get(kind, f"本轮结束原因：{kind}")
            reply += f"\n\n⚠️ {note}"
        return reply


class DshRpcError(RuntimeError):
    def __init__(self, method: str, err: dict):
        self.method = method
        self.code = err.get("code") if isinstance(err, dict) else None
        self.detail = err.get("message") if isinstance(err, dict) else str(err)
        super().__init__(f"DSH {method} 调用失败: {self.detail}")


# ---------------------------------------------------------------- 状态（chat -> session）
class State:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict[str, str] = {}
        if path.exists():
            try:
                self._data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                log.warning("state.json 损坏，已重置", exc_info=True)

    def get(self, chat_id: str) -> str | None:
        with self._lock:
            return self._data.get(chat_id)

    def set(self, chat_id: str, session_id: str) -> None:
        with self._lock:
            self._data[chat_id] = session_id
            self.path.write_text(
                json.dumps(self._data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )


# ---------------------------------------------------------------- 飞书事件处理
MENTION_TOKEN_RE = re.compile(r"@_user_\d+")
LEADING_PUNCT_RE = re.compile(r"^[\s,，。；;:：!！?？]+")


def clean_text(text: str) -> str:
    text = MENTION_TOKEN_RE.sub("", text or "")
    text = LEADING_PUNCT_RE.sub("", text)
    return text.strip()


class Bridge:
    def __init__(self, cfg: dict, dsh: DshClient, im, bot_open_id: str | None = None):
        self.cfg = cfg
        self.dsh = dsh
        self.im = im
        self.bot_open_id = bot_open_id
        self.state = State(BASE_DIR / "state.json")
        self._chat_locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def chat_lock(self, chat_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._chat_locks.get(chat_id)
            if lock is None:
                lock = threading.Lock()
                self._chat_locks[chat_id] = lock
            return lock

    # ---- 发送消息
    def send_text(self, chat_id: str, text: str) -> None:
        from lark_oapi.api.im.v1 import (
            CreateMessageRequest,
            CreateMessageRequestBody,
        )
        body = (
            CreateMessageRequestBody.builder()
            .receive_id(chat_id)
            .msg_type("text")
            .content(json.dumps({"text": text}, ensure_ascii=False))
            .build()
        )
        req = (
            CreateMessageRequest.builder()
            .receive_id_type("chat_id")
            .request_body(body)
            .build()
        )
        resp = self.im.im.v1.message.create(req)
        if not resp.success():
            raise RuntimeError(f"飞书发送失败 code={resp.code} msg={resp.msg}")

    def send_chunked(self, chat_id: str, text: str) -> None:
        """超长回复按块发送。"""
        limit = int(self.cfg.get("reply_chunk_chars", 8000))
        if len(text) <= limit:
            self.send_text(chat_id, text)
            return
        chunks = [text[i:i + limit] for i in range(0, len(text), limit)]
        for i, chunk in enumerate(chunks, 1):
            self.send_text(chat_id, f"（{i}/{len(chunks)}）\n{chunk}")

    # ---- 会话管理
    def get_or_create_session(self, chat_id: str) -> str:
        sid = self.state.get(chat_id)
        if sid:
            return sid
        cwd = self.cfg.get("dsh_cwd") or None
        sid = self.dsh.create_session(cwd=cwd)
        self.state.set(chat_id, sid)
        log.info("为 chat %s 创建 DSH 会话 %s（cwd=%s）", chat_id, sid, cwd)
        return sid

    # ---- 命令
    def handle_command(self, chat_id: str, text: str) -> bool:
        cmd = text.strip().lower()
        if cmd in ("/new", "新对话", "新会话"):
            sid = self.dsh.create_session()
            self.state.set(chat_id, sid)
            self.send_text(chat_id, f"✅ 已开启新对话（会话 {sid[:20]}…）")
            return True
        if cmd in ("/cancel", "取消"):
            sid = self.state.get(chat_id)
            if sid:
                self.dsh.cancel(sid)
                self.send_text(chat_id, "⏹ 已发送取消指令")
            else:
                self.send_text(chat_id, "当前没有进行中的会话")
            return True
        if cmd in ("/status", "状态"):
            sid = self.state.get(chat_id)
            if sid:
                self.send_text(chat_id, f"当前 DSH 会话：{sid}")
            else:
                self.send_text(chat_id, "尚未创建会话，发一句话即可开始")
            return True
        return False

    # ---- 主处理（在独立线程中运行，不阻塞飞书长连接收包）
    def process(self, chat_id: str, text: str) -> None:
        lock = self.chat_lock(chat_id)
        with lock:
            try:
                if not text:
                    self.send_text(chat_id, "ℹ️ 目前只支持文字消息，暂不支持图片/文件。")
                    return
                if self.handle_command(chat_id, text):
                    return
                sid = self.get_or_create_session(chat_id)
                reply = self.dsh.ask(sid, text)
                self.send_chunked(chat_id, reply)
                log.info("chat %s 完成一轮，回复 %d 字", chat_id, len(reply))
            except Exception as exc:  # noqa: BLE001
                log.exception("处理 chat %s 的消息失败", chat_id)
                try:
                    self.send_text(chat_id, f"❌ 出错了：{exc}")
                except Exception:
                    log.exception("发送错误提示也失败了")

    # ---- 事件入口（lark-oapi ws 回调，签名：Callable[[P2ImMessageReceiveV1], None]）
    def on_message(self, event) -> None:
        try:
            msg = event.event.message
            if msg is None or not msg.chat_id:
                return
            chat_id = msg.chat_id
            # 忽略机器人自己发的消息（防止死循环）
            sender = getattr(event.event, "sender", None)
            if sender is not None and getattr(sender, "sender_type", None) == "app":
                return
            # 群聊：只在机器人被 @ 时响应
            chat_type = getattr(msg, "chat_type", "p2p")
            if chat_type == "group" and not self.is_mentioning_bot(msg):
                return
            # 只处理文本消息
            if getattr(msg, "message_type", None) != "text":
                text = ""
            else:
                try:
                    text = json.loads(msg.content or "{}").get("text", "")
                except json.JSONDecodeError:
                    text = ""
            text = clean_text(text)
            threading.Thread(
                target=self.process,
                args=(chat_id, text),
                daemon=True,
            ).start()
        except Exception:  # noqa: BLE001
            log.exception("on_message 分发失败")

    def is_mentioning_bot(self, msg) -> bool:
        mentions = getattr(msg, "mentions", None) or []
        for m in mentions:
            mid = getattr(m, "id", None)
            open_id = getattr(mid, "open_id", None) if mid else None
            if open_id and open_id == self.bot_open_id:
                return True
            # 兜底：不知道机器人 open_id 时，把 @应用 视为 @机器人
            if not self.bot_open_id and getattr(m, "mentioned_type", None) == "app":
                return True
        return False


# ---------------------------------------------------------------- 启动
def fetch_bot_open_id(domain: str, app_id: str, app_secret: str) -> str | None:
    """取机器人自己的 open_id（用于群聊 @ 判断）。失败返回 None。"""
    from lark_oapi import Client as LarkClient
    from lark_oapi.api.auth.v3 import (
        InternalTenantAccessTokenRequest,
        InternalTenantAccessTokenRequestBody,
    )
    try:
        client = (
            LarkClient.builder()
            .app_id(app_id)
            .app_secret(app_secret)
            .domain(domain)
            .build()
        )
        resp = client.auth.v3.tenant_access_token.internal(
            InternalTenantAccessTokenRequest.builder()
            .request_body(
                InternalTenantAccessTokenRequestBody.builder()
                .app_id(app_id)
                .app_secret(app_secret)
                .build()
            )
            .build()
        )
        if not resp.success():
            log.warning("获取 tenant_access_token 失败 code=%s msg=%s", resp.code, resp.msg)
            return None
        # 该接口的 token 平铺在响应顶层，SDK 模型未映射到 data，需从原始响应读取
        token = None
        if resp.data is not None and getattr(resp.data, "tenant_access_token", None):
            token = resp.data.tenant_access_token
        else:
            raw = getattr(resp, "raw", None)
            if raw is not None and getattr(raw, "content", None):
                try:
                    token = json.loads(raw.content.decode("utf-8")).get("tenant_access_token")
                except Exception:  # noqa: BLE001
                    token = None
        if not token:
            log.warning("未能从响应中解析 tenant_access_token")
            return None
        # 获取机器人信息（老接口 bot/v3/info，返回 bot.open_id）
        r = requests.get(
            f"{domain}/open-apis/bot/v3/info",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        data = r.json()
        if data.get("code") != 0:
            log.warning("获取机器人信息失败：%s", data.get("msg"))
            return None
        return (data.get("bot") or {}).get("open_id")
    except Exception:  # noqa: BLE001
        log.warning("获取机器人 open_id 异常", exc_info=True)
        return None


def wait_for_dsh(dsh: DshClient, attempts: int = 12, delay: float = 5.0) -> bool:
    """等待 DSH 就绪（插件随应用启动时 Web 服务可能还没监听）。"""
    for i in range(attempts):
        try:
            dsh.ping()
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("DSH 未就绪（第 %d/%d 次尝试）：%s", i + 1, attempts, exc)
            time.sleep(delay)
    return False


def main() -> None:
    if sys.stdout and hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    cfg = load_config()
    dsh = DshClient(
        base_url=cfg.get("dsh_base_url", "http://127.0.0.1:52199"),
        poll_interval=float(cfg.get("poll_interval_seconds", 2.0)),
        turn_timeout=float(cfg.get("turn_timeout_seconds", 600.0)),
    )

    log.info("检查 DSH 可达性：%s ...", dsh.base_url)
    if not wait_for_dsh(dsh):
        log.error("无法连接 DSH（请确认 DSH Web 正在运行）")
        sys.exit(1)
    log.info("DSH 连接正常")

    from lark_oapi import Client as LarkClient
    from lark_oapi.core.enum import LogLevel
    from lark_oapi.event.dispatcher_handler import EventDispatcherHandler
    from lark_oapi.ws import Client as WSClient

    domain = feishu_domain(cfg)
    app_id = cfg["feishu_app_id"]
    app_secret = cfg["feishu_app_secret"]

    im = (
        LarkClient.builder()
        .app_id(app_id)
        .app_secret(app_secret)
        .domain(domain)
        .log_level(LogLevel.INFO)
        .build()
    )

    bot_open_id = fetch_bot_open_id(domain, app_id, app_secret)
    if bot_open_id:
        log.info("机器人 open_id: %s", bot_open_id)
    else:
        log.warning("未能获取机器人 open_id，群聊 @ 判断使用兜底策略")

    bridge = Bridge(cfg, dsh, im, bot_open_id=bot_open_id)
    handler = (
        EventDispatcherHandler.builder("", "")
        .register_p2_im_message_receive_v1(bridge.on_message)
        .build()
    )

    log.info("启动飞书长连接事件订阅（domain=%s）...", domain)
    ws = WSClient(
        app_id,
        app_secret,
        log_level=LogLevel.INFO,
        event_handler=handler,
        domain=domain,
        auto_reconnect=True,
    )
    ws.start()


if __name__ == "__main__":
    main()
