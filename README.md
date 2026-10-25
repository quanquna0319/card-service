# Local Card Service

**自持卡密验证服务 + 浏览器管理后台** — 一个 Python 进程 + 一个 SQLite 文件，即可完整承载卡密签发、验证、设备绑定与运维。

当前版本：**v1.2.4** · 更新记录见 [CHANGELOG.md](CHANGELOG.md)

---

## 这是什么

`card-service` 提供与既有客户端兼容的 `/api/verify_card.php` 验证接口，同时给管理员一套浏览器控制台，用来管理卡密周期、到期时间、设备绑定和启用状态。

它不替换客户端协议 —— 客户端已内置的表单式验证请求原样可用，只需把地址指向新服务器。

```
客户端  ──POST /api/verify_card.php──►  server.py  ──►  cards.sqlite3
管理员  ──浏览器 / 管理接口──────────►      │
                                            └──►  备份 / 在线更新（GitHub）
```

**核心特性**

| | |
| --- | --- |
| 🔌 **协议兼容** | 保留 `verify_card.php` 接口名与表单编码，客户端零改动接入 |
| 🔐 **卡号不落明文** | 库内只存 HMAC 摘要 + 密钥流加密密文，单库泄露 ≠ 卡号泄露 |
| ⏱ **双到期语义** | 相对周期（首次验证才计时）／固定到期时间，两种模式可选 |
| 📱 **一卡一机** | 首次验证绑定 `app_id` + `uuid`，换设备自动拒绝 |
| 👥 **角色分离** | 管理员可管卡，普通用户仅查看，卡密明文只对管理员下发 |
| 🐳 **单镜像交付** | 122 MB 镜像，只读根文件系统 + 非 root 运行，多架构（amd64/arm64） |
| 🔄 **在线更新** | 网页一键更新，代码进数据卷、数据库不被覆盖，可回滚 |
| 🎮 **魔盒桥接** | 可选：同一端口对外提供魔盒客户端协议，卡密直接查本库 |
| 📦 **零 Python 依赖** | 纯标准库实现，无 `requirements.txt`，不会因依赖升级崩 |

## 文档

完整分析文档在 [`docs/`](docs/)：

| 文档 | 内容 |
| --- | --- |
| [01 · 项目概览](docs/01-overview.md) | 定位、角色模型、授权生命周期、功能全景、技术栈 |
| [02 · 架构与代码结构](docs/02-architecture.md) | 模块地图（1707 行怎么分层）、请求链路、并发模型、前端结构、CI |
| [03 · 数据模型与卡密算法](docs/03-data-model.md) | 表结构、scrypt 参数、80 bit 卡号生成、HMAC-CTR 加密、状态机不变量 |
| [04 · 接口文档](docs/04-api.md) | 23 个端点的权限、入参、响应、错误码 |
| [05 · 部署与运维](docs/05-deployment.md) | 三种部署方式、环境变量全表、更新机制、备份恢复、排障速查 |
| [06 · 安全分析与风险清单](docs/06-security.md) | 威胁模型、18 项已实现措施、17 项风险分级与修复建议 |
| [07 · 生产实例实测报告](docs/07-field-report.md) | 真实主机上的容器拓扑、运行指标、数据画像、结论 |
| [08 · 魔盒授权协议桥接](docs/08-bridge.md) | 魔盒客户端的协议适配层：接口映射、卡密格式转换、部署方式 |

## 快速开始

**Docker Compose（推荐）**

```bash
cp .env.example .env
# 必改两项：CARD_SECRET（openssl rand -hex 32）、CARD_ADMIN_PASSWORD
docker compose up -d --build
curl -fsS http://127.0.0.1:48192/health
```

**本地运行**

```powershell
$env:CARD_SECRET = "LICENSE_BLOB"          # 生产必须换成随机串
$env:CARD_ADMIN_USER = "admin"
$env:CARD_ADMIN_PASSWORD = "ADMIN_PASSWORD"
python .\server.py
```

打开 <http://127.0.0.1:8080/>，用配置的账户登录。

> ⚠️ **两个必须记住的约束**
> 1. **`CARD_SECRET` 不可更换**。它同时是卡密哈希密钥，更换后所有既有卡密立即验证失败且无法恢复。备份数据库时必须同时离线保管它。
> 2. **默认只监听 `127.0.0.1`**。对外发布请走 HTTPS 反向代理（见 `deploy/Caddyfile`），不要直接把端口暴露到公网。

## WebUI 功能

- **管理员**：查看概览、生成月卡/半年卡/年卡、批量生成 1–1000 张、设置固定到期时间、编辑备注、启用/禁用卡密、批量删除、创建用户和管理员、停用账户。
- **维护**：立即备份并下载、查看/下载/删除历史备份、上传恢复、重启服务、一键更新、检查更新、查看更新日志、管理源码包。
- **普通用户**：登录、查看概览和卡密列表；不能生成卡密、不能访问用户管理，也看不到卡密明文。
- 卡密留空到期时间时，**首次验证才开始按周期计时**；设置固定到期时间时，从该时间过期。
- 首次成功验证会绑定 `app_id` 和 `uuid`，之后换设备会被拒绝。

## 客户端验证接口

```bash
curl -X POST http://127.0.0.1:8080/api/verify_card.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "card_code=SERIAL" \
  --data-urlencode "app_id=APP_ID" \
  --data-urlencode "uuid=DEVICE_UUID"
```

响应包含 `status`、`message`，成功时还包含 `data.expire_time` 和 `data.app_notice`。
完整接口清单见 [docs/04-api.md](docs/04-api.md)。

## 目录结构

```
.
├── server.py                 # 全部服务端逻辑（1707 行，纯标准库）
├── mitm_server.py            # 魔盒授权协议桥接（可选，复用 server.py 的 Handler）
├── static/                   # 前端构建产物（由 server.py 提供）
├── frontend/                 # React 19 + HeroUI + Tailwind 源码
│   └── src/{components,lib}  #   视图 / 布局 / API 封装
├── deploy/                   # Caddyfile 与 systemd unit
├── scripts/run-service.ps1   # Windows 进程守护
├── docker-compose.yml        # 生产编排（只读根 + healthcheck）
├── docker-entrypoint.sh      # 启动前置校验 + 数据卷代码优先加载
├── Dockerfile                # python:3.12-slim，UID 10001
├── .github/workflows/        # 构建推送 GHCR + 冒烟测试
└── docs/                     # 分析文档（本项目新增）
```

## 部署

镜像由 GitHub Actions 构建推送至 GHCR：

```text
ghcr.io/quanquna0319/card-service:latest
```

环境变量、HTTPS 反代、备份恢复、升级回滚与排障的完整说明见 [DEPLOY.md](DEPLOY.md) 与 [docs/05-deployment.md](docs/05-deployment.md)。

## 安全提示

上线前请至少完成：

1. 设置高强度 `CARD_SECRET`（≥ 32 字节随机）与管理员口令；
2. 通过反向代理提供 HTTPS，不要暴露裸 HTTP 端口；
3. 限制管理员账户数量，按需降级为普通用户；
4. 建立定期备份，并离线保管 `CARD_SECRET`。

风险清单与加固优先级见 [docs/06-security.md](docs/06-security.md)。
