#!/usr/bin/env python3
"""SQLite-backed card API and role-based management UI server."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DB_PATH = Path(os.environ.get("CARD_DB", ROOT / "cards.sqlite3"))
APP_ID = os.environ.get("CARD_APP_ID", "APP_ID")
SECRET = os.environ.get("CARD_SECRET", "LICENSE_BLOB").encode()
HOST = os.environ.get("CARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("CARD_PORT", "8080"))
SESSION_TTL = 12 * 60 * 60
MAX_CARD_COUNT = 1000
MAX_NOTE_LENGTH = 80
MAX_USERNAME_LENGTH = 32
MAX_PASSWORD_LENGTH = 256
LOCK = threading.RLock()
SESSIONS: dict[str, tuple[int, float]] = {}
STARTED_AT = time.time()
# 每次启动换一个值：容器里 PID 恒为 1，只能靠它判断“真的重启过了”。
BOOT_ID = secrets.token_hex(8)
MAX_BACKUP_BYTES = 32 * 1024 * 1024
BACKUP_DIR = Path(os.environ.get("CARD_BACKUP_DIR", DB_PATH.parent / "backups"))
SERVER_PID = os.getpid()
GIT_REMOTE = os.environ.get("CARD_GIT_REMOTE", "origin")
UPDATE_COMMAND = os.environ.get("CARD_UPDATE_COMMAND", "").strip()
UPDATE_MODE = os.environ.get("CARD_UPDATE_MODE", "auto").strip().lower()
UPDATE_REPO = os.environ.get("CARD_UPDATE_REPO", "quanquna0319/card-service").strip()
UPDATE_BRANCH = os.environ.get("CARD_UPDATE_BRANCH", "main").strip()
UPDATE_DIR = Path(os.environ.get("CARD_UPDATE_DIR", str(DB_PATH.parent)))
INSTALL_DIR = Path(os.environ.get("CARD_UPDATE_INSTALL_DIR", str(ROOT)))
UPDATE_ORIGIN = os.environ.get("CARD_UPDATE_ORIGIN", "https://api.github.com").rstrip("/")
UPDATE_CODELOAD = os.environ.get(
    "CARD_UPDATE_CODELOAD", "https://codeload.github.com"
).rstrip("/")
MAX_UPDATE_BYTES = 64 * 1024 * 1024
UPDATE_LOCK = threading.Lock()
UPDATE_STATE_FILE = UPDATE_DIR / "update-state.json"
UPDATE_PACKAGE_DIR = Path(
    os.environ.get("CARD_UPDATE_PACKAGE_DIR", str(UPDATE_DIR / "update-packages"))
)
MAX_UPDATE_PACKAGES = 5
MAX_CHANGELOG_BYTES = 512 * 1024
GIT_CACHE_TTL = 15.0
GIT_CACHE: dict[str, object] = {"at": 0.0, "value": None}


DURATIONS = {
    "month": timedelta(days=30),
    "half_year": timedelta(days=180),
    "year": timedelta(days=365),
}


def now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).replace(microsecond=0)


def db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sqlite_summary(path: Path) -> dict:
    """读取任意 SQLite 文件的概览；恢复前用它决定是否允许覆盖当前库。"""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if not {"cards", "users"} <= tables:
            raise ValueError("备份缺少 cards 或 users 表")
        card_columns = {row[1] for row in conn.execute("PRAGMA table_info(cards)")}
        user_columns = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
        required_cards = {
            "card_hash",
            "card_type",
            "status",
            "created_at",
            "activated_at",
            "expire_time",
            "device_uuid",
            "app_id",
        }
        required_users = {"username", "password_hash", "role", "created_at", "disabled"}
        if required_cards - card_columns:
            raise ValueError(
                "cards 表字段不完整: " + ", ".join(sorted(required_cards - card_columns))
            )
        if required_users - user_columns:
            raise ValueError(
                "users 表字段不完整: " + ", ".join(sorted(required_users - user_columns))
            )
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValueError(f"备份完整性检查失败: {integrity}")
        summary = {
            "cards": conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0],
            "users": conn.execute("SELECT COUNT(*) FROM users").fetchone()[0],
        }
        for key, clause in (
            ("unused", "status='unused'"),
            ("active", "status='active'"),
            ("disabled", "status='disabled'"),
        ):
            summary[key] = conn.execute(
                f"SELECT COUNT(*) FROM cards WHERE {clause}"
            ).fetchone()[0]
        summary["admins"] = conn.execute(
            "SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0"
        ).fetchone()[0]
        return summary
    finally:
        conn.close()


def snapshot_database(label: str = "auto") -> Path:
    """用 SQLite 在线备份接口做一致性快照，避免复制到写了一半的页。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    suffix = secrets.token_hex(2)
    target = BACKUP_DIR / f"cards-{label}-{stamp}-{suffix}.sqlite3"
    source = sqlite3.connect(DB_PATH, timeout=15)
    dest = sqlite3.connect(target)
    try:
        source.backup(dest)
    finally:
        dest.close()
        source.close()
    return target


def prune_backups(keep: int = 20) -> None:
    if not BACKUP_DIR.is_dir():
        return
    files = sorted(
        (path for path in BACKUP_DIR.glob("*.sqlite3") if path.is_file()),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for stale in files[keep:]:
        stale.unlink(missing_ok=True)


def list_backups() -> list[dict]:
    if not BACKUP_DIR.is_dir():
        return []
    items = []
    for path in sorted(
        BACKUP_DIR.glob("*.sqlite3"), key=lambda item: item.stat().st_mtime, reverse=True
    ):
        stat = path.stat()
        items.append(
            {
                "name": path.name,
                "size": stat.st_size,
                "created_at": datetime.fromtimestamp(
                    stat.st_mtime, timezone.utc
                ).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            }
        )
    return items


def backup_path(name: str) -> Path | None:
    """只允许访问备份目录下的 .sqlite3 文件，挡掉路径穿越。"""
    if not name or "/" in name or "\\" in name or not name.endswith(".sqlite3"):
        return None
    root = BACKUP_DIR.resolve()
    candidate = (root / name).resolve()
    if candidate.parent != root or not candidate.is_file():
        return None
    return candidate


def delete_backup(name: str) -> list[str]:
    """删除备份目录里的快照；name 为空或 * / all 时清空全部。"""
    if not BACKUP_DIR.is_dir():
        return []
    if name in ("", "*", "all"):
        targets = [path for path in BACKUP_DIR.glob("*.sqlite3") if path.is_file()]
    else:
        path = backup_path(name)
        targets = [path] if path is not None else []
    removed: list[str] = []
    for path in targets:
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            continue
    return removed


def run_git(args: list[str], timeout: int = 30) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    # 服务器环境没人能回答账号密码提示，直接失败比挂住请求更好。
    env["GIT_TERMINAL_PROMPT"] = "0"
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        encoding="utf-8",
        errors="replace",
        env=env,
    )


def git_excerpt(proc: subprocess.CompletedProcess[str]) -> str:
    text = (proc.stderr or proc.stdout or "").strip()
    return text[-400:] if text else f"退出码 {proc.returncode}"


def git_info(force: bool = False) -> dict:
    """读取当前工作区的 Git 状态；Docker 镜像内没有 .git 时返回不可用。"""
    cached = GIT_CACHE["value"]
    if (
        not force
        and isinstance(cached, dict)
        and time.time() - float(GIT_CACHE["at"]) < GIT_CACHE_TTL
    ):
        return dict(cached)

    value: dict = {"available": False}
    if (ROOT / ".git").exists() and shutil.which("git"):
        def out(*args: str) -> str:
            proc = run_git(list(args), timeout=10)
            return proc.stdout.strip() if proc.returncode == 0 else ""

        commit = out("rev-parse", "HEAD")
        if commit:
            value = {
                "available": True,
                "branch": out("rev-parse", "--abbrev-ref", "HEAD"),
                "commit": commit,
                "short": out("rev-parse", "--short", "HEAD"),
                "subject": out("log", "-1", "--pretty=%s"),
                "date": out("log", "-1", "--pretty=%cI"),
                # 只看已跟踪文件的改动；本地生成的备份、数据库等未跟踪文件不应阻止更新。
                "dirty": bool(out("status", "--porcelain", "--untracked-files=no")),
            }
    GIT_CACHE["at"] = time.time()
    GIT_CACHE["value"] = value
    return dict(value)


def update_project() -> dict:
    """从远端拉取最新提交，只允许快进合并，工作区有改动时拒绝执行。"""
    if UPDATE_COMMAND:
        return run_update_command()
    if UPDATE_MODE == "none":
        raise ValueError("自动更新已关闭（CARD_UPDATE_MODE=none），请手动升级")

    if UPDATE_MODE == "download" or (
        UPDATE_MODE == "auto" and not git_info(force=True).get("available")
    ):
        return download_update()

    # 更新前强制刷新一次缓存，避免页面展示的旧状态影响判断。
    GIT_CACHE["at"] = 0.0
    GIT_CACHE["value"] = None
    info = git_info(force=True)
    if not info.get("available"):
        raise ValueError(
            "当前运行环境没有 Git 工作区，通常是 Docker 镜像部署。"
            "请在服务器执行 docker compose pull && docker compose up -d，"
            "随后回到本页重启服务；也可以改用 Git 克隆目录运行 python server.py。"
        )
    if info.get("dirty"):
        raise ValueError("工作区存在未提交的修改，已停止更新。请先提交或还原这些修改后重试。")
    branch = str(info.get("branch") or "")
    if not branch or branch == "HEAD":
        raise ValueError("当前处于分离 HEAD 状态，无法自动更新，请先切换到分支。")

    with UPDATE_LOCK:
        before_proc = run_git(["rev-parse", "HEAD"])
        if before_proc.returncode != 0:
            raise ValueError(f"读取当前提交失败：{git_excerpt(before_proc)}")
        before = before_proc.stdout.strip()

        fetch = run_git(["fetch", "--prune", GIT_REMOTE], timeout=90)
        if fetch.returncode != 0:
            raise ValueError(f"拉取远端失败：{git_excerpt(fetch)}")

        remote_ref = f"{GIT_REMOTE}/{branch}"
        remote_proc = run_git(["rev-parse", "--verify", remote_ref])
        if remote_proc.returncode != 0:
            raise ValueError(f"远端不存在分支 {remote_ref}")
        target = remote_proc.stdout.strip()

        # 拉取后重新检查工作区：拉取期间也可能有文件被改动。
        if git_info(force=True).get("dirty"):
            raise ValueError("工作区存在未提交的修改，已停止更新。请先提交或还原这些修改后重试。")

        base = {
            "branch": branch,
            "before": before[:7],
            "after": before[:7],
            "remote": GIT_REMOTE,
            "commits": [],
            "files": [],
        }
        if target == before:
            return {**base, "updated": False}

        pull = run_git(["pull", "--ff-only", GIT_REMOTE, branch], timeout=180)
        if pull.returncode != 0:
            raise ValueError(f"更新失败：{git_excerpt(pull)}")

        after_proc = run_git(["rev-parse", "HEAD"])
        after = after_proc.stdout.strip() if after_proc.returncode == 0 else target
        log = run_git(["log", "--oneline", "--no-decorate", f"{before}..{after}", "--max-count=20"])
        changed = run_git(["diff", "--name-only", before, after])
        commits = [line for line in log.stdout.splitlines() if line.strip()] if log.returncode == 0 else []
        files = [line for line in changed.stdout.splitlines() if line.strip()] if changed.returncode == 0 else []

    GIT_CACHE["value"] = None
    return {
        "updated": after != before,
        "branch": branch,
        "before": before[:7],
        "after": after[:7],
        "remote": GIT_REMOTE,
        "commits": commits,
        "files": files,
    }


def update_api_headers() -> dict[str, str]:
    headers = {
        "User-Agent": "card-service-updater",
        "Accept": "application/vnd.github+json",
    }
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def fetch_bytes(url: str, timeout: int = 30) -> bytes:
    request = urllib.request.Request(url, headers=update_api_headers())
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(MAX_UPDATE_BYTES + 1)


def fetch_json(url: str) -> dict:
    raw = fetch_bytes(url, timeout=20)
    return json.loads(raw.decode("utf-8"))


def remote_commit() -> dict:
    url = f"{UPDATE_ORIGIN}/repos/{UPDATE_REPO}/commits/{UPDATE_BRANCH}"
    payload = fetch_json(url)
    commit = payload.get("commit") or {}
    return {
        "sha": str(payload.get("sha") or ""),
        "short": str(payload.get("sha") or "")[:7],
        "subject": str((commit.get("message") or "").splitlines()[0]),
        "date": str(((commit.get("committer") or {}).get("date")) or ""),
        "files": [
            str(item.get("filename"))
            for item in payload.get("files") or []
            if item.get("filename")
        ],
    }


def update_package_entries() -> list[dict]:
    """列出更新时从 GitHub 下载并留存下来的源码包。"""
    if not UPDATE_PACKAGE_DIR.is_dir():
        return []
    entries: list[dict] = []
    for entry in UPDATE_PACKAGE_DIR.glob("card-service-*.tar.gz"):
        try:
            if not entry.is_file():
                continue
            stat = entry.stat()
        except OSError:
            continue
        short = entry.name[len("card-service-") : -len(".tar.gz")]
        entries.append(
            {
                "name": entry.name,
                "size": stat.st_size,
                "created_at": iso(datetime.fromtimestamp(stat.st_mtime, timezone.utc)),
                "short": short[:7],
            }
        )
    entries.sort(key=lambda item: (item["created_at"] or "", item["name"]), reverse=True)
    return entries


def update_package_path(name: str) -> Path | None:
    """只允许访问包目录内的 .tar.gz，挡掉目录穿越。"""
    if not name or name != Path(name).name or not name.endswith(".tar.gz"):
        return None
    try:
        root = UPDATE_PACKAGE_DIR.resolve()
        candidate = (root / name).resolve()
    except OSError:
        return None
    if candidate.parent != root or not candidate.is_file():
        return None
    return candidate


def prune_update_packages(keep: int = MAX_UPDATE_PACKAGES) -> None:
    """只保留最近几份源码包，避免数据卷被历史更新包占满。"""
    for item in update_package_entries()[keep:]:
        path = update_package_path(item["name"])
        if path is None:
            continue
        try:
            path.unlink()
        except OSError:
            continue


def store_update_package(archive: Path, target: dict) -> dict:
    """把下载下来的源码包留一份，更新完成后可以在页面里下载或删除。"""
    UPDATE_PACKAGE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"card-service-{target['short']}.tar.gz"
    destination = UPDATE_PACKAGE_DIR / name
    temp = destination.with_name(f".{name}.new")
    try:
        shutil.copyfile(archive, temp)
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)
    prune_update_packages()
    stat = destination.stat()
    return {
        "name": name,
        "size": stat.st_size,
        "created_at": iso(now()),
        "short": target["short"],
        "commit": target["sha"],
    }


def changelog_payload() -> dict:
    """读取 CHANGELOG.md；已安装副本优先于当前工作目录。"""
    candidates = [ROOT / "CHANGELOG.md"]
    try:
        if INSTALL_DIR.resolve() != ROOT.resolve():
            candidates.insert(0, INSTALL_DIR / "CHANGELOG.md")
    except OSError:
        pass
    for path in candidates:
        try:
            if not path.is_file():
                continue
            raw = path.read_bytes()
            stat = path.stat()
        except OSError:
            continue
        truncated = len(raw) > MAX_CHANGELOG_BYTES
        text = raw[:MAX_CHANGELOG_BYTES].decode("utf-8", "replace")
        version = ""
        for line in text.splitlines():
            if line.startswith("## "):
                version = line[3:].strip()
                break
        return {
            "available": True,
            "path": str(path),
            "text": text,
            "version": version,
            "size": stat.st_size,
            "updated_at": iso(datetime.fromtimestamp(stat.st_mtime, timezone.utc)),
            "truncated": truncated,
        }
    return {
        "available": False,
        "path": str(ROOT / "CHANGELOG.md"),
        "text": "",
        "version": "",
        "size": 0,
        "updated_at": None,
        "truncated": False,
    }


def changelog_summary() -> dict:
    payload = changelog_payload()
    payload.pop("text", None)
    return payload


def check_update() -> dict:
    """只比对远端有没有新提交，不写任何文件；供页面的“检查更新”按钮调用。"""
    mode = update_mode()
    if mode == "none":
        raise ValueError("自动更新已关闭（CARD_UPDATE_MODE=none），无法检查更新")

    local = installed_commit()
    payload: dict = {
        "mode": mode,
        "supported": True,
        "repo": UPDATE_REPO,
        "branch": UPDATE_BRANCH,
        "local": {
            "commit": local.get("commit") or "",
            "short": local.get("short") or "",
            "subject": local.get("subject") or "",
            "date": local.get("date") or "",
            "branch": local.get("branch") or UPDATE_BRANCH,
        },
        "remote": {"commit": "", "short": "", "subject": "", "date": ""},
        "commits": [],
        "files": [],
        "behind": 0,
        "ahead": 0,
        "updated": False,
        "dirty": bool(local.get("dirty")),
        "pendingRestart": bool(local.get("pendingRestart")),
        "checked_at": iso(now()),
        "note": "",
    }

    if mode == "command":
        # 自定义命令由部署方实现，服务端不知道远端版本，只能如实告知。
        payload["supported"] = False
        payload["note"] = "已配置 CARD_UPDATE_COMMAND，无法比对远端版本；请用该命令自带的版本查询。"
        return payload

    if mode == "download":
        remote = remote_commit()
        payload["remote"] = {
            "commit": remote["sha"],
            "short": remote["short"],
            "subject": remote["subject"],
            "date": remote["date"],
        }
        payload["updated"] = bool(remote["sha"]) and local.get("short") != remote["short"]
        payload["behind"] = 1 if payload["updated"] else 0
        if payload["pendingRestart"] and not install_ready():
            # 副本不完整时“重启后生效”是句空话，直接说清楚是哪里缺了。
            payload["note"] = (
                f"已下载 {local.get('downloaded') or remote['short']}，"
                "但数据卷里的副本没能启动或无法编译，已回退到当前运行代码；"
                "请重新下载更新后再试。"
            )
        elif payload["pendingRestart"]:
            payload["note"] = (
                f"已下载 {local.get('downloaded') or remote['short']}，重启服务后生效。"
            )
        elif payload["updated"]:
            payload["note"] = "点击“更新到最新版本”会下载这份源码包，重启后生效。"
        else:
            payload["note"] = "当前运行的已经是 GitHub 上的最新提交。"
        return payload

    info = git_info(force=True)
    if not info.get("available"):
        payload["supported"] = False
        payload["note"] = "当前环境没有 Git 工作区，无法比对远端分支。"
        return payload
    branch = str(info.get("branch") or "")
    if not branch or branch == "HEAD":
        raise ValueError("当前处于分离 HEAD 状态，请先切换到分支再检查更新")

    with UPDATE_LOCK:
        fetch = run_git(["fetch", "--prune", GIT_REMOTE], timeout=90)
        if fetch.returncode != 0:
            raise ValueError(f"读取远端失败：{git_excerpt(fetch)}")
        local_sha = str(info.get("commit") or "")
        remote_ref = f"{GIT_REMOTE}/{branch}"
        remote_proc = run_git(["rev-parse", "--verify", remote_ref])
        if remote_proc.returncode != 0:
            raise ValueError(f"远端不存在分支 {remote_ref}")
        remote_sha = remote_proc.stdout.strip()
        ahead_proc = run_git(["rev-list", "--count", f"{local_sha}..{remote_ref}"])
        behind_proc = run_git(["rev-list", "--count", f"{remote_ref}..{local_sha}"])
        log = run_git(
            ["log", "--oneline", "--no-decorate", f"{local_sha}..{remote_ref}", "--max-count=20"]
        )
        changed = run_git(["diff", "--name-only", f"{local_sha}..{remote_ref}"])
        subject = run_git(["log", "-1", "--pretty=%s", remote_ref])
        date = run_git(["log", "-1", "--pretty=%cI", remote_ref])

    def count_of(proc: subprocess.CompletedProcess[str]) -> int:
        text = (proc.stdout or "").strip()
        return int(text) if text.isdigit() else 0

    payload["remote"] = {
        "commit": remote_sha,
        "short": remote_sha[:7],
        "subject": (subject.stdout or "").strip() if subject.returncode == 0 else "",
        "date": (date.stdout or "").strip() if date.returncode == 0 else "",
        "branch": branch,
    }
    payload["behind"] = count_of(ahead_proc)  # 远端领先本地的提交数
    payload["ahead"] = count_of(behind_proc)  # 本地领先远端的提交数
    payload["commits"] = [line for line in (log.stdout or "").splitlines() if line.strip()]
    payload["files"] = [line for line in (changed.stdout or "").splitlines() if line.strip()]
    payload["updated"] = bool(remote_sha) and remote_sha != local_sha
    if payload["updated"]:
        payload["note"] = (
            f"{remote_ref} 领先本地 {payload['behind']} 个提交，{len(payload['files'])} 个文件变化。"
        )
    elif payload["ahead"]:
        payload["note"] = f"本地领先远端 {payload['ahead']} 个提交，尚未推送。"
    else:
        payload["note"] = "当前提交与远端分支一致。"
    return payload


def download_update() -> dict:
    """没有 Git 时直接下载源码压缩包，覆盖程序文件后重启即可生效。"""
    if not UPDATE_REPO or "/" not in UPDATE_REPO:
        raise ValueError("CARD_UPDATE_REPO 需要填写 owner/repo，例如 quanquna0319/card-service")
    target = remote_commit()
    local = installed_commit()
    state = read_update_state()
    pending = bool(state.get("pendingRestart"))
    if (
        target["sha"]
        and local.get("short") == target["short"]
        and not pending
        and not local.get("downloaded")
    ):
        return {
            "updated": False,
            "branch": UPDATE_BRANCH,
            "before": local.get("short", ""),
            "after": target["short"],
            "remote": UPDATE_REPO,
            "commits": [],
            "files": [],
        }
    # 已经下载过同一提交但还没重启时，不重复下载。
    if state.get("short") == target["short"] and pending:
        return {
            "updated": False,
            "restart_required": True,
            "branch": UPDATE_BRANCH,
            "before": state.get("short", ""),
            "after": target["short"],
            "remote": UPDATE_REPO,
            "commits": [],
            "files": [],
        }

    # 使用提交号而不是分支名，避免下载过程中分支变动导致内容与元数据不一致。
    archive_url = f"{UPDATE_CODELOAD}/{UPDATE_REPO}/tar.gz/{target['sha']}"
    payload = fetch_bytes(archive_url, timeout=90)
    if len(payload) > MAX_UPDATE_BYTES:
        raise ValueError("更新包超过 64 MB，已停止下载")

    staging = UPDATE_DIR / ".update-staging"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)
    try:
        archive = staging / "source.tar.gz"
        archive.write_bytes(payload)
        extract_dir = staging / "extract"
        extract_dir.mkdir()
        try:
            with tarfile.open(archive, "r:gz") as bundle:
                members = []
                total = 0
                for member in bundle.getmembers():
                    parts = PurePosixPath(member.name).parts
                    if not parts or parts[0] in ("", ".", ".."):
                        raise ValueError("更新包目录结构不正确")
                    if any(part in ("..", "") for part in parts):
                        raise ValueError("更新包包含非法路径")
                    if member.name.startswith("/") or member.islnk() or member.issym():
                        raise ValueError("更新包包含非法链接")
                    if member.isfile():
                        total += member.size
                        if total > MAX_UPDATE_BYTES:
                            raise ValueError("更新包解压后超过 64 MB")
                    if member.isfile() or member.isdir():
                        members.append(member)
                try:
                    bundle.extractall(extract_dir, members=members, filter="data")
                except TypeError:
                    # Python 3.11 及更早版本没有 filter 参数；成员已经手动校验过。
                    bundle.extractall(extract_dir, members=members)
        except (tarfile.TarError, EOFError) as exc:
            raise ValueError(f"更新包解压失败：{exc}") from exc

        roots = [item for item in extract_dir.iterdir() if item.is_dir()]
        if len(roots) != 1:
            raise ValueError("更新包缺少项目目录")
        source = roots[0]
        if not (source / "server.py").is_file() or not (source / "static" / "index.html").is_file():
            raise ValueError("更新包缺少 server.py 或 static/index.html")

        # 留存一份源码包；留存失败不影响本次更新，页面只是少了下载入口。
        try:
            package = store_update_package(archive, target)
        except OSError:
            package = {}

        with UPDATE_LOCK:
            INSTALL_DIR.mkdir(parents=True, exist_ok=True)
            # 根目录下的入口脚本全部安装：1.2.0 起多了 mitm_server.py，
            # 只覆盖 server.py 会让桥接部署拿不到新文件。
            scripts = [item for item in sorted(source.glob("*.py")) if item.is_file()]
            if not any(item.name == "server.py" for item in scripts):
                raise ValueError("更新包缺少 server.py")
            previous_dir = UPDATE_DIR / ".install-previous"
            shutil.rmtree(previous_dir, ignore_errors=True)
            previous_dir.mkdir(parents=True, exist_ok=True)
            for item in scripts:
                current = INSTALL_DIR / item.name
                if current.is_file():
                    shutil.copy2(current, previous_dir / item.name)
            for item in scripts:
                install_file(item, INSTALL_DIR / item.name)
            install_tree(source / "static", INSTALL_DIR / "static")
            # 更新日志随源码包一起安装，页面上的“查看更新日志”才能看到新版本。
            if (source / "CHANGELOG.md").is_file():
                install_file(source / "CHANGELOG.md", INSTALL_DIR / "CHANGELOG.md")
            if not compile_ok(INSTALL_DIR / "server.py"):
                # 装上去的代码根本跑不起来时立刻回滚，别让下一次重启直接离线。
                for item in previous_dir.glob("*.py"):
                    install_file(item, INSTALL_DIR / item.name)
                raise ValueError("更新包里的 server.py 无法编译，已回滚到上一版")
            # 重新下载意味着再给这份副本一次启动机会。
            for flag in (".install-disabled", ".boot-attempts"):
                try:
                    (INSTALL_DIR / flag).unlink(missing_ok=True)
                except OSError:
                    pass
            marker = json.dumps(
                {
                    "available": True,
                    "repo": UPDATE_REPO,
                    "branch": UPDATE_BRANCH,
                    "commit": target["sha"],
                    "short": target["short"],
                    "subject": target["subject"],
                    "date": target["date"],
                    "dirty": False,
                    "previous": local,
                    "package": package.get("name", ""),
                    "entry": entry_name(),
                    "server_sha256": file_sha256(INSTALL_DIR / "server.py"),
                    "pendingRestart": True,
                },
                ensure_ascii=False,
                indent=2,
            )
            UPDATE_DIR.mkdir(parents=True, exist_ok=True)
            UPDATE_STATE_FILE.write_text(marker + "\n", encoding="utf-8")
            # 让容器启动脚本判断这份副本与镜像谁更新。
            (INSTALL_DIR / ".build-revision").write_text(
                target["sha"] + "\n", encoding="utf-8"
            )
            installed_marker = dict(json.loads(marker))
            installed_marker.pop("pendingRestart", None)
            (INSTALL_DIR / ".install-source.json").write_text(
                json.dumps(installed_marker, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            GIT_CACHE["value"] = None
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return {
        "updated": True,
        "restart_required": True,
        "branch": UPDATE_BRANCH,
        "before": local.get("short", ""),
        "after": target["short"],
        "remote": UPDATE_REPO,
        "commits": [f"{target['short']} {target['subject']}".strip()],
        "files": target["files"][:50],
        "package": package,
    }


def install_file(source: Path, target: Path) -> None:
    temp = target.with_name(f".{target.name}.new")
    temp.write_bytes(source.read_bytes())
    temp.chmod(0o644)
    os.replace(temp, target)


def read_update_state() -> dict:
    if not UPDATE_STATE_FILE.is_file():
        return {}
    try:
        data = json.loads(UPDATE_STATE_FILE.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return {}
    return data if isinstance(data, dict) else {}


def install_tree(source: Path, target: Path) -> None:
    """先写入临时目录再整体替换，避免覆盖途中留下半套静态文件。"""
    temp = target.with_name(f"{target.name}.next")
    shutil.rmtree(temp, ignore_errors=True)
    backup = target.with_name(f"{target.name}.old")
    try:
        shutil.copytree(source, temp)
        shutil.rmtree(backup, ignore_errors=True)
        if target.exists():
            target.rename(backup)
        temp.rename(target)
    except Exception:
        # 替换失败时尽量把旧目录放回去，避免页面直接 404。
        if not target.exists() and backup.exists():
            backup.rename(target)
        raise
    finally:
        shutil.rmtree(backup, ignore_errors=True)


def installed_commit() -> dict:
    from_install = running_from_install()
    state = read_update_state()
    pending_info: dict = {}
    if (
        not from_install
        and state.get("pendingRestart")
        and state.get("short")
    ):
        pending_info = {
            "pendingRestart": True,
            "downloaded": state.get("short"),
        }
    if from_install and UPDATE_STATE_FILE.is_file():
        data = state
        if data.get("short"):
            if data.get("pendingRestart"):
                source = ROOT / ".install-source.json"
                try:
                    installed = json.loads(source.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    installed = {}
                applied = bool(
                    isinstance(installed, dict)
                    and installed.get("commit")
                    and installed.get("commit") == data.get("commit")
                )
                if not applied and data.get("server_sha256"):
                    # 标记文件丢了也能认出来：正在跑的 server.py 与下载时记录的摘要一致。
                    try:
                        applied = file_sha256(ROOT / entry_name()) == data["server_sha256"]
                    except OSError:
                        applied = False
                if applied:
                    # 当前执行的正是下载下来的副本，标记已生效。
                    previous = data.get("previous") or {}
                    data.pop("pendingRestart", None)
                    data.pop("previous", None)
                    UPDATE_STATE_FILE.write_text(
                        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8",
                    )
                    return {
                        **data,
                        "previous": previous if isinstance(previous, dict) else {},
                    }
                previous = data.get("previous") or {}
                if isinstance(previous, dict) and previous.get("short"):
                    return {
                        **previous,
                        "available": True,
                        "pendingRestart": True,
                        "downloaded": data.get("short"),
                    }
            return data
    if from_install:
        marker = ROOT / ".install-source.json"
        if marker.is_file():
            try:
                meta = json.loads(marker.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                meta = {}
            if isinstance(meta, dict) and meta.get("short"):
                return {**meta, "available": True}
    revision = ROOT / ".build-revision"
    if not from_install and revision.is_file():
        try:
            sha = revision.read_text(encoding="utf-8").strip()
        except OSError:
            sha = ""
        if sha:
            return {
                "available": True,
                "branch": UPDATE_BRANCH,
                "commit": sha,
                "short": sha[:7],
                "subject": "Docker 镜像构建版本",
                "date": "",
                "dirty": False,
                **pending_info,
            }
    return {**git_info(), **pending_info}


def update_mode() -> str:
    """给页面返回实际生效的更新方式：git / download / command。"""
    if UPDATE_COMMAND:
        return "command"
    if UPDATE_MODE == "none":
        return "none"
    if UPDATE_MODE == "download":
        return "download"
    if UPDATE_MODE == "git":
        return "git" if git_info().get("available") else "none"
    if git_info().get("available"):
        return "git"
    return "download" if os.access(UPDATE_DIR, os.W_OK) else "none"


def run_update_command() -> dict:
    """执行部署方提供的更新命令，用于 Docker / systemd 等没有 .git 的场景。"""
    if os.name == "nt":
        command = ["powershell", "-NoProfile", "-NonInteractive", "-Command", UPDATE_COMMAND]
    else:
        command = ["/bin/sh", "-c", UPDATE_COMMAND]
    with UPDATE_LOCK:
        try:
            proc = subprocess.run(
                command,
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=600,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired as exc:
            raise ValueError("更新命令执行超时（10 分钟）") from exc
    if proc.returncode != 0:
        raise ValueError(f"更新命令失败：{git_excerpt(proc)}")
    tail = (proc.stdout or proc.stderr or "").strip().splitlines()[-20:]
    return {
        "updated": True,
        "restart_required": True,
        "branch": "custom-command",
        "before": "",
        "after": "",
        "remote": UPDATE_COMMAND,
        "commits": tail,
        "files": [],
    }


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str) -> bool:
    try:
        kind, salt_hex, digest_hex = stored.split("$", 2)
        if kind != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1
        ).hex()
        return hmac.compare_digest(actual, digest_hex)
    except (ValueError, TypeError):
        return False


def migrate_database(path: Path) -> None:
    """把数据库结构推进到当前版本；新库和恢复的旧备份都走同一套迁移。"""
    conn = sqlite3.connect(path, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin','user')),
                created_at TEXT NOT NULL,
                disabled INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS cards (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                card_hash TEXT NOT NULL UNIQUE,
                card_secret TEXT,
                card_type TEXT NOT NULL CHECK(card_type IN ('month','half_year','year')),
                status TEXT NOT NULL CHECK(status IN ('unused','active','disabled')),
                created_at TEXT NOT NULL,
                activated_at TEXT,
                expire_time TEXT,
                device_uuid TEXT,
                app_id TEXT,
                note TEXT DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS cards_device_idx ON cards(device_uuid);
            """
        )
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(cards)")}
        if "note" not in columns:
            conn.execute("ALTER TABLE cards ADD COLUMN note TEXT DEFAULT ''")
        if "card_secret" not in columns:
            # 旧版本只保存 HMAC 摘要，无法反推原文；新版本保存加密明文以支持回看与复制。
            conn.execute("ALTER TABLE cards ADD COLUMN card_secret TEXT")
        if "card_code" in columns:
            # 兼容中间版本直接保存明文的列：搬进加密列后清空，避免明文留在库里。
            rows = conn.execute(
                "SELECT id, card_code FROM cards WHERE card_code IS NOT NULL AND card_code != ''"
            ).fetchall()
            for row in rows:
                conn.execute(
                    "UPDATE cards SET card_secret=COALESCE(card_secret, ?), card_code=NULL WHERE id=?",
                    (seal_code(row["card_code"]), row["id"]),
                )
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    migrate_database(DB_PATH)
    with db() as conn:
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            username = os.environ.get("CARD_ADMIN_USER", "admin")
            password = os.environ.get("CARD_ADMIN_PASSWORD", "ADMIN_PASSWORD")
            conn.execute(
                "INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)",
                (username, hash_password(password), "admin", iso(now())),
            )
            print(f"Created initial admin user: {username}")


def digest(card_code: str) -> str:
    return hmac.new(SECRET, card_code.encode(), hashlib.sha256).hexdigest()


def make_card() -> str:
    raw = base64.b32encode(secrets.token_bytes(10)).decode().rstrip("=")
    check = base64.b32encode(
        hmac.new(SECRET, raw.encode(), hashlib.sha256).digest()[:3]
    ).decode()[:4]
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:12]}-{raw[12:16]}-{check}"


def seal_code(card_code: str) -> str:
    """用 CARD_SECRET 派生的密钥流加密卡密明文，数据库单独泄露时不暴露卡号。"""
    nonce = secrets.token_bytes(12)
    key = hmac.new(SECRET, b"card-secret-v1", hashlib.sha256).digest()
    data = card_code.encode()
    stream = bytearray()
    counter = 0
    while len(stream) < len(data):
        stream.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
        counter += 1
    cipher = bytes(left ^ right for left, right in zip(data, stream))
    return base64.urlsafe_b64encode(nonce + cipher).decode()


def open_code(sealed: str | None) -> str | None:
    """还原 seal_code 的结果；密钥变更或数据损坏时返回 None。"""
    if not sealed:
        return None
    try:
        raw = base64.urlsafe_b64decode(sealed.encode())
        nonce, cipher = raw[:12], raw[12:]
        key = hmac.new(SECRET, b"card-secret-v1", hashlib.sha256).digest()
        stream = bytearray()
        counter = 0
        while len(stream) < len(cipher):
            stream.extend(hmac.new(key, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest())
            counter += 1
        return bytes(left ^ right for left, right in zip(cipher, stream)).decode()
    except (ValueError, UnicodeDecodeError):
        return None


def response(result_status: str, message: str = "", **data: object) -> dict:
    result = {"status": result_status, "message": message}
    if data:
        result["data"] = data
    return result


def verify_card(card_code: str, app_id: str, device_uuid: str) -> tuple[int, dict]:
    if not card_code or not app_id or not device_uuid:
        return 400, response("error", "card_code, app_id and uuid are required")
    with LOCK, db() as conn:
        row = conn.execute("SELECT * FROM cards WHERE card_hash=?", (digest(card_code),)).fetchone()
        if row is None:
            return 200, response("error", "卡密不存在")
        if row["status"] == "disabled":
            return 200, response("error", "卡密已禁用")
        current = now()
        expiry = parse_time(row["expire_time"])
        if row["status"] == "active" and expiry:
            if expiry <= current:
                return 200, response("error", "卡密已过期")
            if row["device_uuid"] != device_uuid or row["app_id"] != app_id:
                return 200, response("error", "卡密已绑定其他设备")
            return 200, response("success", "验证成功", expire_time=row["expire_time"], app_notice="")
        if expiry is None:
            expiry = current + DURATIONS[row["card_type"]]
        elif expiry <= current:
            return 200, response("error", "卡密已过期")
        conn.execute(
            "UPDATE cards SET status='active',activated_at=?,expire_time=?,device_uuid=?,app_id=? WHERE id=?",
            (iso(current), iso(expiry), device_uuid, app_id, row["id"]),
        )
        return 200, response("success", "验证成功", expire_time=iso(expiry), app_notice="")


def session_user(token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    with LOCK:
        item = SESSIONS.get(token)
        if not item or item[1] < time.time():
            SESSIONS.pop(token, None)
            return None
    with db() as conn:
        return conn.execute("SELECT * FROM users WHERE id=? AND disabled=0", (item[0],)).fetchone()


def entry_name() -> str:
    """当前进程的入口脚本名（server.py / mitm_server.py）。"""
    name = Path(sys.argv[0] or "").name
    return name if name.endswith(".py") else "server.py"


def compile_ok(path: Path) -> bool:
    """不落盘地检查一份源码能否编译，挡住语法错误的新版本。"""
    try:
        compile(path.read_bytes(), str(path), "exec")
    except (OSError, SyntaxError, ValueError):
        return False
    return True


def install_ready(script: str | None = None) -> bool:
    """数据卷里的副本是否完整可用：入口脚本能编译，前端入口也在。"""
    if (INSTALL_DIR / ".install-disabled").is_file():
        # 连续启动失败过的副本不再自动使用，避免把服务锁死在起不来的版本上。
        return False
    name = script or entry_name()
    target = INSTALL_DIR / name
    return (
        target.is_file()
        and (INSTALL_DIR / "static" / "index.html").is_file()
        and compile_ok(target)
    )


def mark_boot_ok() -> None:
    """端口起来了就算这次启动成功，清掉启动脚本记的失败次数。"""
    try:
        (INSTALL_DIR / ".boot-attempts").unlink(missing_ok=True)
    except OSError:
        pass


def running_from_install() -> bool:
    try:
        return ROOT.resolve() == INSTALL_DIR.resolve()
    except OSError:
        return False


def copy_kind() -> str:
    """当前进程跑的是哪份代码，用来解释“重启为什么没生效”。"""
    if running_from_install():
        return "install"
    return "git" if (ROOT / ".git").exists() else "image"


def exec_new_process(script: Path) -> bool:
    """用指定脚本原地替换当前进程；成功不返回，失败返回 False。

    不依赖 systemd / docker 的拉起策略：即使裸跑 `python server.py`，
    也能在更新后自己换成新代码，避免“重启了还是旧版本”。
    """
    # 新老副本的 ROOT 往往不同，必须把绝对路径固定下来，否则数据库会换位置。
    os.environ["CARD_DB"] = str(DB_PATH)
    os.environ["CARD_BACKUP_DIR"] = str(BACKUP_DIR)
    os.environ["CARD_UPDATE_DIR"] = str(UPDATE_DIR)
    os.environ["CARD_UPDATE_INSTALL_DIR"] = str(INSTALL_DIR)
    os.environ["CARD_UPDATE_PACKAGE_DIR"] = str(UPDATE_PACKAGE_DIR)
    argv = [sys.executable, str(script), *sys.argv[1:]]
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    except (OSError, ValueError):
        pass
    try:
        os.execv(sys.executable, argv)
    except OSError as exc:
        print(f"切换到 {script} 失败：{exc}", file=sys.stderr)
        return False
    return True


def switch_to_installed_copy() -> None:
    """镜像副本启动时，若数据卷里有已下载的更新，直接换成更新的副本。

    启动脚本的 CMD 匹配只覆盖 `python /app/server.py` 一种写法；
    `python3`、带 `-u`、自定义 command 或桥接入口都会绕过它，
    这里在进程内再兜一次，保证“重启即生效”。
    """
    if running_from_install():
        return
    state = read_update_state()
    if not state.get("pendingRestart"):
        return
    script = INSTALL_DIR / entry_name()
    if not install_ready():
        print(
            f"数据卷里的更新副本不可用（{script} 缺失或无法编译），继续使用当前代码",
            file=sys.stderr,
        )
        return
    print(f"检测到已下载的更新 {state.get('short', '')}，切换到 {script}")
    if not exec_new_process(script):
        print("切换失败，继续使用当前代码", file=sys.stderr)


def schedule_restart(delay: float = 1.0) -> None:
    """先响应客户端，再换成最新代码重新执行；换不动才退出等守护进程拉起。"""

    def worker() -> None:
        time.sleep(delay)
        target: Path | None = None
        if install_ready():
            target = INSTALL_DIR / entry_name()
        elif (ROOT / entry_name()).is_file():
            target = ROOT / entry_name()
        if target is not None and exec_new_process(target):
            return
        os._exit(0)

    threading.Thread(target=worker, daemon=True).start()


def restore_database(payload: bytes) -> dict:
    """校验上传的 SQLite 文件后原子替换当前库。

    替换顺序：写临时文件 -> 校验 -> 备份现库 -> os.replace 原子换入。
    """
    if not payload:
        raise ValueError("备份内容为空")
    if len(payload) > MAX_BACKUP_BYTES:
        raise ValueError("备份文件不能超过 32 MB")
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    temp = DB_PATH.with_name(f".restore-{secrets.token_hex(6)}.tmp")
    temp.write_bytes(payload)
    try:
        summary = sqlite_summary(temp)
    except sqlite3.DatabaseError as exc:
        temp.unlink(missing_ok=True)
        raise ValueError(f"不是有效的 SQLite 备份：{exc}") from exc
    except Exception:
        temp.unlink(missing_ok=True)
        raise

    safety = snapshot_database("before-restore")
    # 先补齐备份里的结构，再替换主库，避免恢复后的库缺少新列。
    migrate_database(temp)
    shutil.move(str(temp), str(DB_PATH))
    prune_backups()
    return {
        "summary": summary,
        "safety_backup": safety.name,
        "size": DB_PATH.stat().st_size,
        "sha256": file_sha256(DB_PATH),
    }


def admin_user(handler: BaseHTTPRequestHandler) -> sqlite3.Row | None:
    authorization = handler.headers.get("Authorization", "")
    if not authorization.lower().startswith("bearer "):
        return None
    return session_user(authorization[7:].strip())


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalCardService/2.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"{self.address_string()} - {fmt % args}")

    def send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_params(self) -> dict[str, str]:
        length = int(self.headers.get("Content-Length", "0"))
        if length > 1_000_000:
            raise ValueError("request body is too large")
        raw = self.rfile.read(length).decode()
        if self.headers.get("Content-Type", "").startswith("application/json"):
            value = json.loads(raw or "{}")
            if not isinstance(value, dict):
                raise ValueError("request body must be an object")
            return {str(k): str(v) for k, v in value.items()}
        return {k: v[-1] for k, v in parse_qs(raw).items()}

    def require_user(self, admin_only: bool = False) -> sqlite3.Row | None:
        user = admin_user(self)
        if user is None or (admin_only and user["role"] != "admin"):
            self.send_json(401 if user is None else 403, response("error", "未授权"))
            return None
        return user

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(
                200,
                response(
                    "success",
                    service="local-card-service",
                    pid=SERVER_PID,
                    boot=BOOT_ID,
                    uptime=int(time.time() - STARTED_AT),
                    db=str(DB_PATH),
                ),
            )
            return
        if parsed.path == "/api/system":
            user = self.require_user(admin_only=True)
            if not user:
                return
            self.send_json(
                200,
                response(
                    "success",
                    pid=SERVER_PID,
                    boot=BOOT_ID,
                    uptime=int(time.time() - STARTED_AT),
                    db=str(DB_PATH),
                    db_size=DB_PATH.stat().st_size if DB_PATH.exists() else 0,
                    db_sha256=file_sha256(DB_PATH) if DB_PATH.exists() else "",
                    backup_dir=str(BACKUP_DIR),
                    backups=list_backups(),
                    git=installed_commit(),
                    copy=copy_kind(),
                    entry=entry_name(),
                    install_dir=str(INSTALL_DIR),
                    install_ready=install_ready(),
                    update_mode=update_mode(),
                    update_repo=UPDATE_REPO,
                    update_branch=UPDATE_BRANCH,
                    update_package_dir=str(UPDATE_PACKAGE_DIR),
                    update_packages=update_package_entries(),
                    changelog=changelog_summary(),
                ),
            )
            return
        if parsed.path == "/api/changelog":
            user = self.require_user(admin_only=True)
            if not user:
                return
            payload = changelog_payload()
            self.send_json(
                200,
                response(
                    "success",
                    "更新日志已读取" if payload["available"] else "没有找到 CHANGELOG.md",
                    **payload,
                ),
            )
            return
        if parsed.path == "/api/update/check":
            user = self.require_user(admin_only=True)
            if not user:
                return
            payload = check_update()
            self.send_json(
                200,
                response(
                    "success",
                    "检查完成" if payload.get("supported") else "无法比对远端版本",
                    **payload,
                ),
            )
            return
        if parsed.path == "/api/update/package":
            user = self.require_user(admin_only=True)
            if not user:
                return
            name = parse_qs(parsed.query).get("name", [""])[-1]
            candidate = update_package_path(name)
            if candidate is None:
                self.send_json(404, response("error", "更新包不存在或已被删除"))
                return
            body = candidate.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/gzip")
            self.send_header(
                "Content-Disposition", f'attachment; filename="{candidate.name}"'
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/backup/download":
            user = self.require_user(admin_only=True)
            if not user:
                return
            try:
                path = snapshot_database("manual")
                prune_backups()
            except sqlite3.Error as exc:
                self.send_json(500, response("error", f"备份失败: {exc}"))
                return
            body = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.sqlite3")
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{path.name}"',
            )
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/backup/file":
            user = self.require_user(admin_only=True)
            if not user:
                return
            name = parse_qs(parsed.query).get("name", [""])[-1]
            candidate = backup_path(name)
            if candidate is None:
                self.send_json(404, response("error", "备份不存在"))
                return
            body = candidate.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.sqlite3")
            self.send_header("Content-Disposition", f'attachment; filename="{candidate.name}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/me":
            user = self.require_user()
            if user:
                self.send_json(200, response("success", user=dict(id=user["id"], username=user["username"], role=user["role"])))
            return
        if parsed.path == "/api/dashboard":
            user = self.require_user()
            if not user:
                return
            with db() as conn:
                stats = {
                    "cards": conn.execute("SELECT COUNT(*) FROM cards").fetchone()[0],
                    "active": conn.execute("SELECT COUNT(*) FROM cards WHERE status='active'").fetchone()[0],
                    "unused": conn.execute("SELECT COUNT(*) FROM cards WHERE status='unused'").fetchone()[0],
                    "users": conn.execute("SELECT COUNT(*) FROM users WHERE disabled=0").fetchone()[0],
                }
            self.send_json(200, response("success", stats=stats))
            return
        if parsed.path == "/api/cards":
            user = self.require_user()
            if not user:
                return
            can_view_code = user["role"] == "admin"
            with db() as conn:
                rows = []
                for row in conn.execute("SELECT id,card_secret,card_type,status,created_at,activated_at,expire_time,device_uuid,app_id,note FROM cards ORDER BY id DESC"):
                    item = dict(row)
                    sealed = item.pop("card_secret", None)
                    # 卡密明文只对管理员回显，普通账户既不拿明文也不拿密文。
                    item["card_code"] = open_code(sealed) if can_view_code else None
                    rows.append(item)
            self.send_json(200, response("success", cards=rows))
            return
        if parsed.path == "/api/users":
            user = self.require_user(admin_only=True)
            if not user:
                return
            with db() as conn:
                rows = [dict(r) for r in conn.execute("SELECT id,username,role,created_at,disabled FROM users ORDER BY id DESC")]
            self.send_json(200, response("success", users=rows))
            return
        if parsed.path == "/" or parsed.path == "/index.html":
            self.serve_static("index.html")
            return
        self.serve_static(parsed.path.lstrip("/"))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/backup/restore":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0:
                    raise ValueError("缺少备份内容")
                if length > MAX_BACKUP_BYTES:
                    raise ValueError("备份文件不能超过 32 MB")
                payload = self.rfile.read(length)
                result = restore_database(payload)
                self.send_json(
                    200,
                    response("success", "备份已恢复", **result),
                )
                return
            if parsed.path == "/api/restart":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                self.send_json(
                    200,
                    response(
                        "success",
                        "服务正在重启，页面将在数秒后自动重连",
                        pid=SERVER_PID,
                    ),
                )
                schedule_restart()
                return
            params = self.read_params()
            if parsed.path == "/api/backup/delete":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                name = params.get("name", "").strip()
                removed = delete_backup(name)
                message = "备份已删除" if removed else "备份不存在或已被删除"
                self.send_json(
                    200,
                    response(
                        "success",
                        message,
                        deleted=removed,
                        backups=list_backups(),
                    ),
                )
                return
            if parsed.path == "/api/update/package/delete":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                name = params.get("name", "").strip()
                removed: list[str] = []
                if name in ("", "*", "all"):
                    # 不带名字时清空全部更新包。
                    for item in update_package_entries():
                        path = update_package_path(item["name"])
                        if path is None:
                            continue
                        try:
                            path.unlink()
                        except OSError as exc:
                            self.send_json(500, response("error", f"删除更新包失败: {exc}"))
                            return
                        removed.append(item["name"])
                else:
                    path = update_package_path(name)
                    if path is None:
                        self.send_json(404, response("error", "更新包不存在或已被删除"))
                        return
                    try:
                        path.unlink()
                    except OSError as exc:
                        self.send_json(500, response("error", f"删除更新包失败: {exc}"))
                        return
                    removed.append(path.name)
                self.send_json(
                    200,
                    response(
                        "success",
                        f"已删除 {len(removed)} 个更新包" if removed else "没有需要删除的更新包",
                        deleted=removed,
                        packages=update_package_entries(),
                    ),
                )
                return
            if parsed.path == "/api/update":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                restart = params.get("restart", "").strip().lower() in ("1", "true", "yes", "on")
                result = update_project()
                self.send_json(
                    200,
                    response(
                        "success",
                        "更新命令已执行"
                        if result["branch"] == "custom-command"
                        else (
                            "已更新到最新版本"
                            if result["updated"]
                            else (
                                "新版本已下载，重启服务后生效"
                                if result.get("restart_required")
                                else "已经是最新版本"
                            )
                        ),
                        **result,
                    ),
                )
                if restart and (result["updated"] or result.get("restart_required")):
                    # Docker restart 策略、systemd 或启动脚本负责拉起进程。
                    schedule_restart()
                return
            if parsed.path.rstrip("/") == "/api/verify_card.php":
                code, result = verify_card(params.get("card_code", ""), params.get("app_id", APP_ID), params.get("uuid", ""))
                self.send_json(code, result)
                return
            if parsed.path == "/api/login":
                with db() as conn:
                    user = conn.execute("SELECT * FROM users WHERE username=? AND disabled=0", (params.get("username", ""),)).fetchone()
                if not user or not check_password(params.get("password", ""), user["password_hash"]):
                    self.send_json(401, response("error", "用户名或密码错误"))
                    return
                token = secrets.token_urlsafe(32)
                SESSIONS[token] = (user["id"], time.time() + SESSION_TTL)
                self.send_json(200, response("success", token=token, user=dict(id=user["id"], username=user["username"], role=user["role"])))
                return
            if parsed.path == "/api/logout":
                SESSIONS.pop(self.headers.get("Authorization", "").removeprefix("Bearer "), None)
                self.send_json(200, response("success"))
                return
            if parsed.path == "/api/cards/generate":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                card_type = params.get("card_type", "month")
                count = int(params.get("count", "1"))
                if not 1 <= count <= MAX_CARD_COUNT:
                    self.send_json(400, response("error", f"count must be between 1 and {MAX_CARD_COUNT}"))
                    return
                if card_type not in DURATIONS:
                    self.send_json(400, response("error", "invalid card_type"))
                    return
                note = params.get("note", "").strip()
                if len(note) > MAX_NOTE_LENGTH:
                    self.send_json(400, response("error", f"note must be at most {MAX_NOTE_LENGTH} characters"))
                    return
                fixed_expire_value = params.get("expire_time", "").strip()
                fixed_expire_dt = parse_time(fixed_expire_value) if fixed_expire_value else None
                if fixed_expire_dt and fixed_expire_dt <= now():
                    self.send_json(400, response("error", "expire_time must be in the future"))
                    return
                fixed_expire = iso(fixed_expire_dt)
                created = []
                with LOCK, db() as conn:
                    for _ in range(count):
                        for _attempt in range(5):
                            code = make_card()
                            try:
                                conn.execute("INSERT INTO cards(card_hash,card_secret,card_type,status,created_at,expire_time,note) VALUES(?,?,?,?,?,?,?)", (digest(code), seal_code(code), card_type, "unused", iso(now()), fixed_expire, note))
                                created.append(code)
                                break
                            except sqlite3.IntegrityError:
                                if _attempt == 4:
                                    raise RuntimeError("could not allocate a unique card code")
                self.send_json(200, response("success", cards=created, card_type=card_type, expire_time=fixed_expire))
                return
            if parsed.path == "/api/cards/update":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                card_id = int(params.get("id", "0"))
                note = params.get("note", "").strip()
                if len(note) > MAX_NOTE_LENGTH:
                    self.send_json(400, response("error", f"note must be at most {MAX_NOTE_LENGTH} characters"))
                    return
                new_expire_value = params.get("expire_time", "").strip()
                new_expire_dt = parse_time(new_expire_value) if new_expire_value else None
                if new_expire_dt and new_expire_dt <= now():
                    self.send_json(400, response("error", "expire_time must be in the future"))
                    return
                with db() as conn:
                    row = conn.execute("SELECT status FROM cards WHERE id=?", (card_id,)).fetchone()
                    if not row:
                        self.send_json(404, response("error", "卡密不存在"))
                        return
                    if row["status"] == "active" and new_expire_dt is None:
                        self.send_json(400, response("error", "active cards require an expiry time"))
                        return
                    cur = conn.execute("UPDATE cards SET expire_time=?,note=? WHERE id=?", (iso(new_expire_dt), note, card_id))
                self.send_json(200 if cur.rowcount else 404, response("success" if cur.rowcount else "error", "已更新" if cur.rowcount else "卡密不存在"))
                return
            if parsed.path == "/api/cards/toggle":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                card_id = int(params.get("id", "0"))
                with db() as conn:
                    row = conn.execute("SELECT status,expire_time,device_uuid,app_id FROM cards WHERE id=?", (card_id,)).fetchone()
                    if not row:
                        self.send_json(404, response("error", "卡密不存在"))
                        return
                    if row["status"] != "disabled":
                        status = "disabled"
                    else:
                        expiry = parse_time(row["expire_time"])
                        status = "active" if row["device_uuid"] and row["app_id"] and expiry and expiry > now() else "unused"
                    conn.execute("UPDATE cards SET status=? WHERE id=?", (status, card_id))
                self.send_json(200, response("success", status=status))
                return
            if parsed.path == "/api/cards/delete":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                raw_ids = params.get("ids", "").strip()
                parts = [part.strip() for part in raw_ids.split(",") if part.strip()]
                if not parts:
                    self.send_json(400, response("error", "请选择要删除的卡密"))
                    return
                if len(parts) > MAX_CARD_COUNT:
                    self.send_json(400, response("error", f"一次最多删除 {MAX_CARD_COUNT} 张卡密"))
                    return
                ids: list[int] = []
                for part in parts:
                    try:
                        card_id = int(part)
                    except ValueError:
                        self.send_json(400, response("error", "卡密编号不正确"))
                        return
                    if card_id <= 0:
                        self.send_json(400, response("error", "卡密编号不正确"))
                        return
                    if card_id not in ids:
                        ids.append(card_id)
                placeholders = ",".join("?" for _ in ids)
                with LOCK, db() as conn:
                    cur = conn.execute(f"DELETE FROM cards WHERE id IN ({placeholders})", tuple(ids))
                    deleted = cur.rowcount
                if deleted == 0:
                    self.send_json(404, response("error", "卡密不存在或已被删除"))
                    return
                print(
                    f"admin={user['username']} deleted={deleted} ids={','.join(str(i) for i in ids)}"
                )
                self.send_json(
                    200,
                    response(
                        "success",
                        f"已删除 {deleted} 张卡密",
                        deleted=deleted,
                        missing=len(ids) - deleted,
                    ),
                )
                return
            if parsed.path == "/api/users/create":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                username, password, role = params.get("username", "").strip(), params.get("password", ""), params.get("role", "user")
                if not 3 <= len(username) <= MAX_USERNAME_LENGTH or not 8 <= len(password) <= MAX_PASSWORD_LENGTH or role not in ("user", "admin"):
                    self.send_json(400, response("error", f"用户名长度为3-{MAX_USERNAME_LENGTH}位，密码长度为8-{MAX_PASSWORD_LENGTH}位"))
                    return
                try:
                    with db() as conn:
                        conn.execute("INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)", (username, hash_password(password), role, iso(now())))
                    self.send_json(200, response("success", "用户已创建"))
                except sqlite3.IntegrityError:
                    self.send_json(409, response("error", "用户名已存在"))
                return
            if parsed.path == "/api/users/toggle":
                user = self.require_user(admin_only=True)
                if not user:
                    return
                user_id = int(params.get("id", "0"))
                if user_id == user["id"]:
                    self.send_json(400, response("error", "不能禁用当前管理员"))
                    return
                with db() as conn:
                    cur = conn.execute("UPDATE users SET disabled=CASE disabled WHEN 0 THEN 1 ELSE 0 END WHERE id=?", (user_id,))
                self.send_json(200 if cur.rowcount else 404, response("success" if cur.rowcount else "error"))
                return
            self.send_json(404, response("error", "not found"))
        except (ValueError, TypeError) as exc:
            self.send_json(400, response("error", str(exc)))
        except Exception as exc:
            self.send_json(500, response("error", str(exc)))

    def serve_static(self, relative: str) -> None:
        path = (STATIC / relative).resolve()
        try:
            path.relative_to(STATIC.resolve())
        except ValueError:
            self.send_json(404, response("error", "not found"))
            return
        if not path.is_file():
            self.send_json(404, response("error", "not found"))
            return
        body = path.read_bytes()
        immutable = relative.startswith("assets/")
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(str(path))[0] or "application/octet-stream")
        # 构建产物带哈希，可以长期缓存；入口文件必须每次校验，否则更新后仍加载旧页面。
        self.send_header(
            "Cache-Control",
            "public, max-age=31536000, immutable" if immutable else "no-cache",
        )
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    # 启动脚本没换到数据卷副本时（自定义 CMD / python3 / 桥接入口），这里补一切换。
    switch_to_installed_copy()
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    mark_boot_ok()
    print(f"Card service listening on http://{HOST}:{PORT}")
    server.serve_forever()
