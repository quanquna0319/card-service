# 05 · 部署与运维

## 1. 三种部署形态

| 形态 | 适用场景 | 进程管理 | 更新方式 |
| --- | --- | --- | --- |
| **Docker Compose** | 生产推荐 | `restart: unless-stopped` | 网页一键更新（下载源码包到数据卷） |
| **systemd** | 裸机 / VPS 直跑 | `Restart=always` | Git 拉取或手动替换 |
| **PowerShell 循环** | Windows 本地调试 | `run-service.ps1` 循环拉起 | Git 拉取 |

> **共同前提**：三种方式都要求外部进程管理器能把"以退出码 0 结束"的进程重新拉起 —— 网页上的"重启服务"正是靠这个机制生效。没有进程管理器时，点重启会真的停服。

## 2. 环境变量全表

### 2.1 核心配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CARD_SECRET` | `LICENSE_BLOB`（禁止用于生产） | **HMAC 与加密主密钥，投入生产后不可更换**（更换 = 全部卡密失效） |
| `CARD_APP_ID` | `APP_ID` | 应用标识，会写入卡密绑定信息 |
| `CARD_ADMIN_USER` | `admin` | 首次启动创建的管理员用户名（仅在用户表为空时生效） |
| `CARD_ADMIN_PASSWORD` | `ADMIN_PASSWORD` | 首次启动创建的管理员密码（要求 ≥ 10 位） |
| `CARD_HOST` | `127.0.0.1` | 监听地址；Docker 内固定 `0.0.0.0` |
| `CARD_PORT` | `8080` | 监听端口 |
| `CARD_DB` | `<脚本目录>/cards.sqlite3` | 数据库路径；Docker 内 `/data/cards.sqlite3` |
| `CARD_BACKUP_DIR` | 数据库同级的 `backups/` | 备份快照目录 |
| `TZ` | 系统默认 | 仅影响日志显示，不影响业务时间（内部全 UTC） |
| `ALLOW_INSECURE_DEFAULTS` | 未设置 | 设为 `1` 时跳过启动时的弱默认值检查，**仅限本地试用** |

### 2.2 更新相关

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CARD_UPDATE_MODE` | `auto` | `auto` / `git` / `download` / `command` |
| `CARD_UPDATE_COMMAND` | 空 | 设置后**优先执行**该命令，覆盖其他模式 |
| `CARD_UPDATE_REPO` | `quanquna0319/card-service` | GitHub 仓库，`owner/name` |
| `CARD_UPDATE_BRANCH` | `main` | 更新分支 |
| `CARD_UPDATE_DIR` | 数据库同级 | 存放 `update-state.json` 的目录，Docker 内 `/data` |
| `CARD_UPDATE_INSTALL_DIR` | 脚本目录 | 下载模式的代码安装目录，Docker 内 `/data/app` |
| `CARD_UPDATE_PACKAGE_DIR` | `<UPDATE_DIR>/update-packages` | 留存源码包目录，只保留最近 5 份 |
| `CARD_UPDATE_ORIGIN` | `https://api.github.com` | API 基址，可指向镜像站 |
| `CARD_UPDATE_CODELOAD` | `https://codeload.github.com` | 源码包下载基址 |
| `CARD_GIT_REMOTE` | `origin` | Git 模式使用的远端名 |
| `GITHUB_TOKEN` | 空 | 私有仓库或 API 限流时的只读令牌 |

### 2.3 反向代理（Caddy，可选）

| 变量 | 说明 |
| --- | --- |
| `CARD_DOMAIN` | 对外域名，Caddy 据此自动申请证书 |
| `ACME_EMAIL` | ACME 注册邮箱 |
| `CARD_IMAGE_DIR` | 容器内镜像代码目录，默认 `/app`（entrypoint 用） |

## 3. 部署方式 A：Docker Compose（推荐）

### 3.1 步骤

```bash
# 1. 准备配置（务必修改两处必填项）
cp .env.example .env
#    CARD_SECRET=<至少 32 字节随机串>
#    CARD_ADMIN_PASSWORD=<至少 10 位强密码>

# 2. 生成一个合格密钥
openssl rand -hex 32

# 3. 启动
docker compose up -d --build

# 4. 验证
curl -fsS http://127.0.0.1:48192/health
```

`docker-compose.yml` 中的安全加固项已默认启用：

```yaml
read_only: true                    # 根文件系统只读
tmpfs: [/tmp]                      # 仅 /tmp 可写
security_opt: [no-new-privileges]  # 禁止提权
user: 10001:10001                  # 非 root（Dockerfile 内声明）
volumes: [./data:/data]            # 唯一可写挂载点
healthcheck: 每 30s 打 /health
```

### 3.2 端口

默认 `48192:8080`。对外暴露前建议改为只绑本机：`127.0.0.1:48192:8080`，再由 Nginx/Caddy 反代并加 TLS。

### 3.3 镜像来源

CI 构建后推送至：

```
ghcr.io/<owner>/card-service:latest     # 默认分支
ghcr.io/<owner>/card-service:v1.1.2     # 语义化版本标签
```

支持 `linux/amd64` 与 `linux/arm64`（ARM 服务器可直接拉取）。

## 4. 部署方式 B：systemd（裸机）

```bash
sudo mkdir -p /opt/card-service
sudo cp -r ./* /opt/card-service/
sudo cp deploy/card-service.service /etc/systemd/system/
sudo install -m 600 .env.example /etc/card-service.env   # 编辑为真实值
sudo chmod 600 /etc/card-service.env                      # 必须收紧权限
sudo systemctl daemon-reload
sudo systemctl enable --now card-service
```

Unit 文件关键点（`deploy/card-service.service`）：

```ini
Restart=always      # 必须：网页重启以 0 退出，需要被拉起
RestartSec=3
EnvironmentFile=/etc/card-service.env
```

## 5. 部署方式 C：Windows 本地

```powershell
$env:CARD_SECRET = "<随机串>"
$env:CARD_ADMIN_USER = "admin"
$env:CARD_ADMIN_PASSWORD = "<强密码>"
.\scripts\run-service.ps1 -Port 8080
```

`run-service.ps1` 是一个 `while($true)` 包装器：退出码 0 视为"用户主动重启"，1 秒后立即拉起；非 0 视为崩溃，5 秒后重试。

## 6. HTTPS 反向代理

`deploy/Caddyfile` 提供开箱配置：

```caddyfile
{$CARD_DOMAIN} {
    encode zstd gzip
    reverse_proxy card-service:8080 {
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "same-origin"
    }
}
```

Caddy 会自动申请并续期 Let's Encrypt 证书。**生产环境强烈建议走这条路** —— 卡密与管理口令在明文 HTTP 下传输是可被中间人直接截获的（见 06 文档）。

## 7. 更新机制详解

### 7.1 三种模式如何选择

`update_mode()` 的判断顺序：

```
1. CARD_UPDATE_COMMAND 非空        → command
2. 存在 .git 且为合法 Git 仓库      → git
3. 其余（典型：Docker 镜像内）      → download
```

### 7.2 Git 模式

```bash
git fetch --prune
git pull --ff-only          # 只允许快进合并
```

**保护措施**：执行前检查已跟踪文件是否有未提交改动，有则拒绝更新（避免覆盖运维手工修改）。

### 7.3 下载模式（Docker 无 `.git`）

```
1. GET api.github.com/repos/{repo}/commits/{branch}   → 取最新 commit sha
2. GET codeload.github.com/{repo}/tar.gz/{sha}        → 下载源码包（≤ 64 MB）
3. 校验：路径穿越、符号链接、文件数量、解压后总体积
4. 解压到 /data/app 的临时目录
5. 整体替换 /data/app/static（失败回滚旧目录）
6. 写入 update-state.json：{commit, subject, pendingRestart:true, package:...}
7. 留存源码包到 update-packages/（保留最近 5 份）
8. 按需重启 → entrypoint 优先加载 /data/app/server.py
```

**为什么新代码放 `/data/app` 而不是覆盖 `/app`**：容器根文件系统是 `read_only: true`，且 `/data` 是持久卷 —— 这样更新能跨容器重建存活，而数据库也在 `/data`，两者互不覆盖。

**版本仲裁**：`docker-entrypoint.sh` 比较镜像内 `.build-revision` 与 `/data/app/.build-revision` 的 **mtime**：

- 数据卷副本更新 → 用数据卷副本；
- 镜像更新（如 `docker compose pull`）→ 用镜像；
- 存在 `pendingRestart: true` → 强制用数据卷副本，避免"待重启生效"状态被误清。

### 7.4 检查更新（只读）

`GET /api/update/check` 只做 `git fetch` 或 GitHub API 查询，**不下载、不写盘**，返回：

- 远端领先 / 本地领先的提交数
- 新提交标题列表与变化文件数
- 工作区是否有未提交修改
- 自定义命令模式下返回 `supported: false`（无法比对版本）

## 8. 备份与恢复

### 8.1 自动与手动

| 触发 | 行为 |
| --- | --- |
| 维护页"立即备份并下载" | 生成快照 → 下载 → 保留在 `backups/` |
| 更新前（部分路径） | 自动快照，label=`auto` |
| 手动上传恢复 | 覆盖当前库，先临时文件后原子替换 |

快照命名：`cards-<label>-<YYYYmmdd-HHMMSS>-<4位随机>.sqlite3`；自动轮转保留 **20 份**。

### 8.2 为什么用在线备份 API

```python
source = sqlite3.connect(DB_PATH, timeout=15)
dest = sqlite3.connect(target)
source.backup(dest)      # SQLite 官方在线备份接口
```

直接 `cp cards.sqlite3` 在写入过程中可能拷到"写了一半的页"，得到**静默损坏**的备份。在线备份 API 会加锁、按事务一致点复制，这是该实现最值得肯定的一处细节。

### 8.3 恢复流程

```
上传文件 → 校验大小(≤32MB) → 校验 SQLite 头 → 写临时文件
        → migrate_database()（兼容旧结构）
        → 原子替换正式库 → 清理临时文件
```

**恢复旧版备份是安全的**：迁移函数对新库、旧库、恢复库执行同一套幂等升级，会自动补齐 `note`、`card_secret` 列。

> ⚠️ 恢复的前提是 `CARD_SECRET` 与备份生成时**一致**。换了 SECRET 再恢复，卡密全部无法验证 —— 备份时请把 SECRET 一并妥善保管。

## 9. 排障速查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 容器起不来，日志 `refusing to start: set CARD_SECRET` | 密钥缺失或为默认值 `LICENSE_BLOB` | 设置真实 `CARD_SECRET`（≥16 字符） |
| 容器起不来，`CARD_ADMIN_PASSWORD must be at least 10 characters` | 口令太短 | 改长口令 |
| 所有卡密突然"卡密不存在" | `CARD_SECRET` 被改 | **立即改回原值**，否则数据不可恢复 |
| 点重启后服务没起来 | 无进程管理器 | 配 `restart: unless-stopped` 或 `Restart=always` |
| 更新后仍跑旧版本 | `pendingRestart` 未生效 / 未重启 | 查看 `/api/system` 的 `git` 与 `update_mode`，手动重启 |
| 更新提示工作区有改动 | Git 模式拒绝脏工作区 | `git stash` 或提交后再更新 |
| 备份下载 404 | 文件名越界或不在备份目录 | 文件名只能取 `backups/` 内的 `.sqlite3` |
| 普通用户看不到卡号 | 设计如此 | 明文仅管理员可见 |
| 旧备份里的卡号显示为空 | 旧版只存 HMAC 摘要，无法还原 | 需重新生成卡密 |

## 10. 升级与回滚

**升级**：网页一键更新，或 `docker compose pull && docker compose up -d`。

**回滚**（Docker）：

```bash
docker compose down
# 方案一：指定旧版本镜像标签
docker compose up -d  # 改 image 为 ghcr.io/<owner>/card-service:v1.1.1
# 方案二：删除数据卷里的新代码，回退到镜像内版本
rm -rf ./data/app
docker compose up -d
```

回滚代码**不需要回滚数据库** —— 迁移是只增列、不删列的向前兼容设计，旧代码在新增列存在时仍可运行。
