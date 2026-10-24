#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
魔盒中间人服务端 · 合并 card-service 卡密体系
================================================

一个进程、一个端口，同时提供两套东西：

  1. 魔盒 3.1.0 的私有协议（/card/sign、/card/active、/card/info、
     /feature/list、/launch/sign、/launch/check、/map/key …）
  2. card-service 的管理后台与接口（/、/api/login、/api/cards/generate …）

卡密校验不再"一律放行"，而是直接查 card-service 的 SQLite 库：
只有用它后台签发、未过期、未禁用、设备匹配的卡密，才能激活魔盒。

    ┌────────────┐  /card/active   ┌────────────────────┐
    │ 魔盒 APK   │ ───────────────▶│ 本服务 :8080        │
    └────────────┘   account=卡密   │  ├ 魔盒协议适配      │
                                    │  └ 复用 card-service │
    ┌────────────┐  /api/cards/...  │     的 Handler      │
    │ 浏览器后台 │ ───────────────▶│        │             │
    └────────────┘                  └────────┼─────────────┘
                                             ▼
                                      cards.sqlite3

为什么卡密是 16 字符
--------------------
魔盒把 account 当 AES-128 密钥（`aa.ah.av(str, key)`，key 必须 16 字节），
长度不对会抛异常、协程静默中断。card-service 的卡号原始载荷正好是
16 个 base32 字符（`XXXX-XXXX-XXXX-XXXX` 再加 4 位校验），所以本服务：

  * 生成卡密默认保持 **原始 5 段格式**（--card-format dash），如 KFR5-B34K-G73H-JC5F-NU47
  * 校验时兼容 16 字符 / 20 字符无横杠 / 24 字符带横杠三种写法
  * 回给客户端的 account 统一取前 16 字符，保证 AES 密钥长度正确
  * 即使输入框把 24 位截断成 16 位，也能由载荷反推校验码补全完整卡号

用法
----
    git clone https://github.com/quanquna0319/card-service.git

    # CARD_SECRET 必须与库创建时一致，否则所有卡密都会"不存在"
    CARD_SECRET=你的密钥 python mitm_server.py --card-service ./card-service

    # 浏览器打开 http://<ip>:8080/ 登录后台，生成卡密
    # 魔盒里输入该卡密激活

找不到 card-service 时自动退化为"一律放行"的纯 Mock 模式，并打印警告。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
import secrets
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------- 魔盒侧配置

FEATURES = [
    {"icon": "ic_location", "identify": "location",
     "label": "防止偷偷被定位，保护您的位置隐私", "name": "位置保护", "showSwitch": True},
    {"icon": "ic_camera", "identify": "camera",
     "label": "自定义相机内容，防止相机隐私被窃取", "name": "相机保护", "showSwitch": True},
    {"icon": "ic_wifi", "identify": "network",
     "label": "禁止获取设备网络信息，防止设备信息被偷偷记录", "name": "WIFI保护", "showSwitch": True},
    {"icon": "ic_phone", "identify": "device",
     "label": "设置设备信息，防止设备信息泄露", "name": "品牌保护", "showSwitch": True},
]

MAP_KEY = "YF9aplVex9MtgMs5Cj1wq3OK"

CARD_TYPE_TEXT = {"month": "月卡", "half_year": "半年卡", "year": "年卡"}

# 魔盒协议端点；其余路径交给 card-service 的 Handler（管理后台/接口/静态页）
MB_POST = {
    "/card/sign", "/card/active", "/card/info",
    "/feature/list", "/launch/sign", "/launch/check",
    "/map/key", "/app/c", "/feedback/list", "/feedback/add",
}
MB_GET = {"/home/notice/get"}

STATE_LOCK = threading.RLock()

# 运行时装配（main 中填充）
SVC = None                  # card-service 模块
TOKENS: dict[str, dict] = {}
STATE_FILE = None
APP_ID = "com.sandbox.dsim"
ALLOW_ANY = False
CARD_FORMAT = "dash"


# ---------------------------------------------------------------- 工具

def now_local() -> datetime:
    return datetime.now().astimezone()


def iso_to_local(text: str) -> str:
    """card-service 的 UTC ISO8601 → 魔盒要的 'YYYY-MM-DD HH:MM:SS' 本地时间。"""
    if not text:
        return ""
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return text


def norm_account(code: str) -> str:
    """取卡密前 16 个字母数字字符，满足客户端 AES-128 密钥长度要求。"""
    cleaned = "".join(ch for ch in (code or "") if ch.isalnum())[:16]
    return cleaned.ljust(16, "0") if len(cleaned) < 16 else cleaned


def code_variants(raw: str) -> list[str]:
    """同一张卡的多种写法：原样 / 大写 / 无横杠 / 标准带横杠。"""
    base = (raw or "").strip()
    if not base:
        return []
    out: list[str] = []

    def add(value: str) -> None:
        if value and value not in out:
            out.append(value)

    add(base)
    up = base.upper()
    add(up)
    dashless = up.replace("-", "").replace(" ", "")
    add(dashless)
    if len(dashless) == 20:
        add("-".join(dashless[i:i + 4] for i in range(0, 16, 4)) + "-" + dashless[16:])
    if len(dashless) == 16:
        add("-".join(dashless[i:i + 4] for i in range(0, 16, 4)))
    return out


def rebuild_card(raw: str, secret: bytes) -> list[str]:
    """由前 16 位载荷反推完整 24 位卡号。

    card-service 的校验码是 HMAC(secret, 载荷) 的确定性派生：
        check = base32(hmac_sha256(secret, raw)[:3])[:4]
    所以哪怕输入框把 24 位截断成 16 位，服务端也能补回完整卡号再查库。
    """
    alnum = "".join(ch for ch in (raw or "") if ch.isalnum()).upper()
    if len(alnum) < 16:
        return []
    payload = alnum[:16]
    try:
        check = base64.b32encode(
            hmac.new(secret, payload.encode(), hashlib.sha256).digest()[:3]
        ).decode()[:4]
    except Exception:
        return []
    grouped = "-".join(payload[i:i + 4] for i in range(0, 16, 4)) + "-" + check
    return [grouped, payload + check]


def save_state() -> None:
    if not STATE_FILE:
        return
    try:
        with STATE_LOCK:
            tmp = STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(TOKENS, f, ensure_ascii=False)
            os.replace(tmp, STATE_FILE)
    except Exception as exc:
        print("[state] 保存失败:", exc)


def load_state() -> None:
    global TOKENS
    if not STATE_FILE or not os.path.exists(STATE_FILE):
        return
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            TOKENS = data
            print("[state] 已恢复 %d 个会话" % len(TOKENS))
    except Exception as exc:
        print("[state] 读取失败:", exc)


# ---------------------------------------------------------------- 装载 card-service

def load_card_service(path: str, db_path: str, secret: str, card_format: str):
    """把 card-service 的 server.py 当模块加载，并接管卡密生成格式。"""
    entry = os.path.join(path, "server.py")
    if not os.path.isfile(entry):
        return None

    # 必须在 exec 前设置：card-service 在模块级读取这两个环境变量
    os.environ["CARD_DB"] = db_path
    os.environ["CARD_SECRET"] = secret

    spec = importlib.util.spec_from_file_location("card_service_impl", entry)
    module = importlib.util.module_from_spec(spec)
    sys.modules["card_service_impl"] = module
    spec.loader.exec_module(module)
    module.init_db()

    if card_format == "16":
        def make_card_16() -> str:
            """16 字符纯载荷，正好等于 AES-128 的密钥长度。"""
            return base64.b32encode(secrets.token_bytes(10)).decode().rstrip("=")

        module.make_card = make_card_16
    return module


# ---------------------------------------------------------------- HTTP 处理

def build_handler(svc):
    base = svc.Handler if svc else BaseHTTPRequestHandler

    class Handler(base):
        server_version = "MagicBoxBridge/2.0"

        # ---------- 通用 ----------
        def log_message(self, fmt, *args):
            print("%s %s" % (time.strftime("%H:%M:%S"), fmt % args))
            sys.stdout.flush()

        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _params(self):
            q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n:
                    raw = self.rfile.read(n).decode("utf-8", "ignore")
                    if raw.strip().startswith("{"):
                        q.update({k: str(v) for k, v in json.loads(raw).items()})
                    else:
                        q.update({k: v[0] for k, v in parse_qs(raw).items()})
            except Exception:
                pass
            return q

        @staticmethod
        def ok(result=None, msg="请求成功"):
            return {"ret": 0, "result": result, "msg": msg, "error": ""}

        @staticmethod
        def fail(msg):
            return {"ret": 1, "result": None, "msg": msg, "error": ""}

        # ---------- 路由 ----------
        def do_POST(self):
            path = urlparse(self.path).path
            if path in MB_POST or path.startswith(("/feedback/", "/dingtalk/")):
                return self.mb(path)
            if svc is None:
                return self._json(self.fail("card-service 未加载"), 503)
            return super().do_POST()

        def do_GET(self):
            path = urlparse(self.path).path
            if path in MB_GET or path in MB_POST:
                return self.mb(path)
            if svc is None:
                return self._json(self.fail("card-service 未加载"), 503)
            return super().do_GET()

        # ---------- 魔盒协议 ----------
        def mb(self, path):
            p = self._params()

            if path == "/card/sign":
                # 真实服务端这一步只校验签名格式，不查库；真正查库在 active
                code = p.get("account", "")
                print("[card/sign] account=%r" % code)
                return self._json(self.ok("BRIDGE-CHALLENGE-" + norm_account(code)))

            if path == "/card/active":
                return self.mb_active(p)

            if path == "/card/info":
                return self.mb_info()

            if path == "/feature/list":
                return self._json(self.ok(FEATURES))

            if path == "/launch/sign":
                return self._json(self.ok("BRIDGE-LAUNCH-" + norm_account(p.get("sp", ""))))

            if path == "/launch/check":
                return self._json(self.ok({
                    "ie": secrets.token_urlsafe(24),
                    "sid": int(time.time()),
                    "sign": secrets.token_urlsafe(32),
                    "type": 2,
                }))

            if path == "/map/key":
                return self._json(self.ok(MAP_KEY))

            if path == "/app/c":
                return self._json(self.ok(None))

            if path == "/home/notice/get":
                return self._json({"message": "Not Found"}, 404)

            if path == "/feedback/list":
                return self._json(self.ok([]))

            return self._json(self.ok(True))   # feedback/add、dingtalk/*

        def mb_active(self, p):
            code_raw = p.get("account", "")
            uuid = p.get("imei", "") or "unknown-device"
            print("[card/active] 卡密=%r 设备=%r" % (code_raw, uuid))

            if svc is None or ALLOW_ANY:
                token = self.issue(code_raw, "", "永久会员", uuid)
                print("[card/active] 未接卡密库，按放行处理")
                return self._json(self.ok(token))

            last_msg = "卡密不存在"
            candidates = code_variants(code_raw)
            for extra in rebuild_card(code_raw, svc.SECRET):
                if extra not in candidates:
                    candidates.append(extra)

            for variant in candidates:
                record = self.lookup_card(variant)
                # 已在卡上绑定过 app_id 的，沿用它；新卡才用配置值
                use_app_id = (record or {}).get("app_id") or APP_ID
                status, resp = svc.verify_card(variant, use_app_id, uuid)
                if resp.get("status") == "success":
                    expire_iso = (resp.get("data") or {}).get("expire_time", "")
                    card_type = (record or {}).get("card_type", "")
                    token = self.issue(variant, expire_iso,
                                       CARD_TYPE_TEXT.get(card_type, "会员"), uuid)
                    print("[card/active] 通过：%r 到期 %s" % (variant, expire_iso))
                    return self._json(self.ok(token))
                last_msg = resp.get("message") or last_msg
                print("[card/active] 写法 %r 未通过：%s" % (variant, last_msg))
                if last_msg != "卡密不存在":
                    break   # 已找到记录但被拒（过期/禁用/绑机），换写法也没用

            print("[card/active] 拒绝：%s" % last_msg)
            return self._json(self.fail(last_msg))

        def lookup_card(self, code):
            """查卡记录：返回 card_type / app_id / status，查不到返回 None。

            app_id 必须以卡上记录的为准 —— 生产库里同一套卡可能分布在多个
            app_id 下（不同客户端各自注册），固定用配置值会把它们判成"绑定其他设备"。
            """
            try:
                with svc.LOCK, svc.db() as conn:
                    row = conn.execute(
                        "SELECT card_type, app_id, status FROM cards WHERE card_hash=?",
                        (svc.digest(code),)).fetchone()
                return dict(row) if row else None
            except Exception:
                return None

        def issue(self, code, expire_iso, summary, uuid):
            token = secrets.token_urlsafe(36)
            with STATE_LOCK:
                TOKENS[token] = {
                    "code": code,
                    "account": norm_account(code),
                    "expire": expire_iso,
                    "end_time": iso_to_local(expire_iso),
                    "summary": summary,
                    "device": uuid,
                    "at": int(time.time()),
                }
            save_state()
            return token

        def mb_info(self):
            token = self.headers.get("m-token") or ""
            with STATE_LOCK:
                item = TOKENS.get(token)
            if not item:
                print("[card/info] 无有效会话（token=%s…）" % (token[:12],))
                return self._json(self.fail("未登录"))

            end_time = item.get("end_time") or ""
            period = 0
            try:
                if end_time:
                    expire = datetime.strptime(end_time, "%Y-%m-%d %H:%M:%S").astimezone()
                    period = max(0, (expire - now_local()).days)
            except Exception:
                pass

            return self._json(self.ok({
                "account": item["account"],
                "activeTime": time.strftime("%Y-%m-%d %H:%M:%S"),
                "endTime": end_time,
                "period": period,
                "summary": item.get("summary") or "会员",
            }))

    return Handler


# ---------------------------------------------------------------- 入口

def main():
    global SVC, STATE_FILE, APP_ID, ALLOW_ANY, CARD_FORMAT

    ap = argparse.ArgumentParser(description="魔盒中间人服务端（合并 card-service）")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--card-service", default=os.environ.get("CARD_SERVICE_DIR", "card-service"),
                    help="card-service 仓库目录（含 server.py）")
    ap.add_argument("--card-db", default=os.environ.get("CARD_DB", "cards.sqlite3"))
    ap.add_argument("--card-secret", default=os.environ.get("CARD_SECRET", "LICENSE_BLOB"))
    ap.add_argument("--app-id", default=os.environ.get("CARD_APP_ID", "com.sandbox.dsim"))
    ap.add_argument("--card-format", choices=["16", "dash"], default="dash",
                    help="dash=原始 5 段格式（默认），16=纯载荷")
    ap.add_argument("--allow-any", action="store_true", help="不校验卡密，一律放行（调试）")
    ap.add_argument("--state", default=os.environ.get("MITM_STATE", "mitm_state.json"))
    args = ap.parse_args()

    APP_ID = args.app_id
    ALLOW_ANY = args.allow_any
    CARD_FORMAT = args.card_format
    STATE_FILE = os.path.abspath(args.state)

    print("=" * 66)
    print(" 魔盒中间人服务端 · card-service 合并版")
    print("=" * 66)

    SVC = load_card_service(os.path.abspath(args.card_service),
                            os.path.abspath(args.card_db),
                            args.card_secret, args.card_format)

    if SVC is None:
        print("! 未找到 card-service（%s/server.py）" % args.card_service)
        print("  当前为纯 Mock 模式：任何卡密都会被接受。")
        print("  需要真实校验请先 git clone 该项目，再用 --card-service 指定目录。")
    else:
        print("[ok] 已接入 card-service：%s" % os.path.abspath(args.card_db))
        print("     app_id   = %s" % APP_ID)
        print("     卡密格式 = %s" % ("16 字符纯载荷" if CARD_FORMAT == "16" else "原始 5 段（24 字符）"))
        host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
        print("     后台入口 = http://%s:%d/" % (host, args.port))

    load_state()
    print("     会话文件 = %s" % STATE_FILE)
    print("-" * 66)
    print("等待请求…（Ctrl+C 停止）")

    srv = ThreadingHTTPServer((args.host, args.port), build_handler(SVC))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        srv.shutdown()


if __name__ == "__main__":
    main()
