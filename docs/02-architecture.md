# 02 · 架构与代码结构

## 1. 整体形态

```
                    ┌──────────────────────────────┐
   浏览器（管理员）  │  React 19 SPA (static/)       │
                    │  HeroUI 3 · Tailwind 4 · Vite │
                    └──────────────┬───────────────┘
                                   │ JSON + Bearer Token
                    ┌──────────────▼───────────────┐
   客户端（样本）    │  server.py                    │
   form-urlencoded  │  ThreadingHTTPServer          │
   ────────────────►│  ├── /api/verify_card.php     │
                    │  ├── /api/* 管理接口          │
                    │  └── / 静态文件               │
                    └──────┬────────────┬──────────┘
                           │            │
                   ┌───────▼──────┐  ┌──▼─────────────┐
                   │ cards.sqlite3│  │ 外部：GitHub   │
                   │ users/cards  │  │ API + codeload │
                   └──────────────┘  └────────────────┘
```

三个刻意的架构选择：

1. **单进程单文件服务**。没有 nginx 前置、没有 WSGI 容器，`python server.py` 即可对外服务。部署复杂度压到最低，代价是单点、无横向扩展能力。
2. **前后端同源**。前端构建产物落进 `static/`，由同一个 `Handler` 提供，不存在跨域与独立前端部署。
3. **零第三方 Python 依赖**。`server.py` 只 import 标准库（`http.server` / `sqlite3` / `hashlib` / `hmac` / `tarfile` / `urllib`），因此镜像构建不需要 `requirements.txt`，也不会因依赖升级而崩。

## 2. `server.py` 模块地图（1707 行）

按代码组织顺序，可划分为 7 个逻辑层：

### 2.1 配置层（L1–L73）

全部通过环境变量注入，无配置文件。关键常量：

| 常量 | 来源 | 默认 |
| --- | --- | --- |
| `SECRET` | `CARD_SECRET` | `LICENSE_BLOB`（不安全默认） |
| `DB_PATH` | `CARD_DB` | `<脚本目录>/cards.sqlite3` |
| `HOST` / `PORT` | `CARD_HOST` / `CARD_PORT` | `127.0.0.1` / `8080` |
| `APP_ID` | `CARD_APP_ID` | `APP_ID` |
| `SESSION_TTL` | 硬编码 | 12 小时 |
| `MAX_CARD_COUNT` | 硬编码 | 1000 |
| `MAX_NOTE_LENGTH` | 硬编码 | 80 |
| `MAX_BACKUP_BYTES` | 硬编码 | 32 MB |
| `MAX_UPDATE_BYTES` | 硬编码 | 64 MB |
| `DURATIONS` | 硬编码 | 30 / 180 / 365 天 |

进程级共享状态只有三样：`SESSIONS`（token → (user_id, 过期时间)）、`LOCK`（`RLock`）、`UPDATE_LOCK`。

### 2.2 时间工具层（L75–L92）

`now()` / `iso()` / `parse_time()` 三个函数统一时区处理：**内部一律 UTC、存储一律 ISO8601 带 `Z`、精度截断到秒**。`parse_time()` 对无时区输入按 UTC 解释，避免本地时区写入导致的到期漂移。

### 2.3 存储层（L94–L240）

- `db()`：**每次调用新建连接**（不缓存、不池化），`timeout=15` 用于等锁，`row_factory=Row` 让结果可按列名访问。SQLite 本身是文件锁，多线程下靠超时重试而非连接池。
- `migrate_database()`：幂等迁移。先 `CREATE TABLE IF NOT EXISTS`，再用 `PRAGMA table_info` 检测缺失列并 `ALTER TABLE` 补齐（`note` / `card_secret`）。**新库和从旧备份恢复的库走同一套迁移路径**，这是它能安全恢复老备份的关键。
- 备份子系统：`snapshot_database()` 用 SQLite 官方 **在线备份 API**（`source.backup(dest)`）而非文件拷贝，避免拷到写了一半的页导致快照损坏；`prune_backups(keep=20)` 轮转保留 20 份；`backup_path()` / `delete_backup()` 对文件名做白名单校验（只接受备份目录内 `.sqlite3`）。

### 2.4 更新子系统（L241–L952，约 700 行，占全文件 40%）

这是代码量最大、也是风险最集中的部分。三种策略由 `update_mode()` 决策：

| 模式 | 判定条件 | 行为 |
| --- | --- | --- |
| `git` | 存在 `.git` 且无 `CARD_UPDATE_COMMAND` | `git fetch` + `git pull --ff-only`，只允许快进，工作区有已跟踪改动则拒绝 |
| `command` | 设置了 `CARD_UPDATE_COMMAND` | 执行自定义脚本，优先级最高 |
| `download` | Docker 环境无 `.git` | 从 GitHub API 取最新 commit → codeload 下载 tar.gz → 校验 → 解压到 `/data/app` |

配套函数：`check_update()`（只读比对，不落盘）、`download_update()`（下载+校验+安装）、`install_tree()`（先写临时目录再整体替换，失败回滚）、`store_update_package()`（留存源码包，只保留最近 5 份）、`installed_commit()`（识别当前运行的是镜像还是数据卷副本）。

下载模式的关键设计 —— **代码与数据分离**：新代码写进 `/data/app`（数据卷），数据库在 `/data/cards.sqlite3`，更新永远不会覆盖数据库。容器启动脚本 `docker-entrypoint.sh` 通过比较 `.build-revision` 文件的 **mtime** 决定加载镜像内代码还是数据卷副本，并用 `update-state.json` 里的 `pendingRestart` 标记避免重复提示。

### 2.5 密码与卡密算法层（L953–L1080）

四个函数构成全部安全逻辑，详见 [03-data-model.md](03-data-model.md)：

```
hash_password / check_password   → scrypt 口令哈希
digest(card_code)                → HMAC-SHA256，查表键 + 防伪
make_card()                      → 生成 20 字符卡号（带校验位）
seal_code / open_code            → 用 SECRET 派生的密钥流加解密明文
```

### 2.6 业务层（L1081–L1178）

- `verify_card()`：验证核心，返回 `(HTTP 状态码, 响应体)`。注意成功与失败都返回 **HTTP 200**，靠 body 里的 `status` 字段区分（仅缺参数时返回 400）—— 这是为兼容既有客户端而保留的约定。
- `session_user()` / `admin_user()`：从 `Authorization: Bearer` 取 token，校验过期并支持滑动续期。
- `schedule_restart()`：起一个 1 秒延迟的线程，然后以退出码 0 结束进程，交由 systemd / PowerShell 循环 / Docker `restart: unless-stopped` 拉起。
- `restore_database()`：上传恢复，先落临时文件、校验 SQLite 头、迁移、再原子替换。

### 2.7 HTTP 层（L1179–L1707）

`Handler(BaseHTTPRequestHandler)` 是唯一的路由入口，结构极其扁平：

```
do_GET  / do_POST
  └─ urlparse(self.path)
      └─ read_params()            # 自动识别 JSON 与 form-urlencoded，body 上限 1MB
          └─ if path == "/api/xxx":  # 顺序 if 链，无路由表
              ├─ require_user(admin_only=?)
              ├─ 参数校验
              ├─ with LOCK, db() as conn: ...
              └─ send_json(code, response(...))
```

设计特点与代价：

- **优点**：无框架黑盒，改动即所见；`send_json()` 统一注入 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。
- **代价**：23 个端点挤在两个函数里（`do_GET` 约 174 行、`do_POST` 约 292 行），新增端点需手写分支；参数校验散落各处、重复度较高。
- **错误处理**：外层 `except (ValueError, TypeError)` → 400，`except Exception` → 500，且**把原始异常消息直接返回给客户端**（见 06 安全文档）。

## 3. 一次验证请求的完整链路

以客户端验证卡密为例：

```
1. POST /api/verify_card.php
   Content-Type: application/x-www-form-urlencoded
   card_code=XXXX-XXXX-XXXX-XXXX-XXXX&app_id=wqx&uuid=device-abc

2. do_POST → read_params() 解析为 dict

3. 参数非空校验 → 任一缺失返回 400

4. digest(card_code) = HMAC-SHA256(SECRET, code)
   → SELECT * FROM cards WHERE card_hash = ?

5. 分支判定：
   ├─ 无记录            → {"status":"error","message":"卡密不存在"}
   ├─ status=disabled   → {"status":"error","message":"卡密已禁用"}
   ├─ status=active 且已过期 → "卡密已过期"
   ├─ status=active 且设备不符 → "卡密已绑定其他设备"
   ├─ status=active 且一切正常 → 直接返回既有 expire_time（不延长）
   └─ 未激活 → 计算 expire_time = now + DURATIONS[type]
               写入 status=active / activated_at / expire_time / device_uuid / app_id

6. 返回 {"status":"success","message":"验证成功","data":{"expire_time":"...","app_notice":""}}
```

关键点：**重复验证不会重置或延长到期时间**，只做读取校验。这防止了客户端反复调用导致永久授权。

## 4. 并发与一致性

| 关注点 | 实现 |
| --- | --- |
| 请求并发 | `ThreadingHTTPServer`，每请求一线程 |
| 共享状态保护 | 全局 `LOCK: RLock`，包住 `SESSIONS` 读写与所有卡密写操作 |
| 数据库写并发 | SQLite 文件锁 + `timeout=15`；写操作额外套 `LOCK` 串行化 |
| 卡密唯一性 | `card_hash` 唯一索引 + 插入冲突时最多重试 5 次重新生成 |
| 备份一致性 | 在线备份 API 快照，非文件拷贝 |
| 更新互斥 | 独立 `UPDATE_LOCK`，防止并发触发两次更新 |

`db()` 无连接池意味着高并发下每个请求都要开一次 SQLite 连接。对本项目量级（单实例、管理员操作 + 客户端低频验证）完全够用，但不适合作为高 QPS 公共 API。

## 5. 前端结构（`frontend/src`，4408 行）

```
main.tsx (16)          挂载入口
App.tsx (138)          登录态判定 + 视图切换
components/
  layout/              AppShell / Sidebar / Topbar / MobileTabBar / Aurora / nav-items
  views/
    LoginView.tsx      (122)   登录页
    DashboardView.tsx  (263)   概览
    CardsView.tsx      (1055)  卡密管理（最重，含生成弹窗、批量操作、复制）
    UsersView.tsx      (470)   账户管理
    SystemView.tsx     (1217)  维护页（备份/更新/重启/日志，最重）
lib/
  api.ts (324)         统一 fetch 封装 + Bearer 注入 + 错误处理
  types.ts (152)       接口类型定义
  format.ts (166)      时间/状态格式化
  theme.ts (39)        明暗主题持久化
  utils.ts (88)        cn() 等工具
```

前端无路由库，靠 `App.tsx` 里的状态切换视图；无状态管理库，数据在视图内 `useState` + `useEffect` 拉取。适合中等规模后台，但 `CardsView` / `SystemView` 各超千行，后续扩展建议按功能拆分子组件。

主题在 `index.html` 里用内联脚本提前读 `localStorage.card_theme`，避免首屏闪烁（FOUC），这是服务端渲染无关场景下的正确做法。

## 6. CI / 构建

`.github/workflows/build-image.yml` 两条流水线：

1. **build**：Buildx 多架构（amd64 + arm64）构建并推送到 `ghcr.io/<owner>/card-service`，标签策略为分支名 / PR / semver / `latest`（仅默认分支），构建参数 `CARD_BUILD_REVISION=<sha>` 写入镜像。
2. **smoke**（依赖 build）：构建本地镜像后跑三轮验证 ——
   - 用弱默认值（`CARD_SECRET=LICENSE_BLOB`）启动，**必须失败**，证明拒绝不安全配置的逻辑有效；
   - 用随机密钥正常启动，探测 `/health`、`/`、字体文件；
   - 用不存在的卡密调用验证接口，断言返回 `"status": "error"`。

这个冒烟测试设计值得借鉴：它不仅测"能不能跑"，还**反向测试"不安全配置必须起不来"**。
