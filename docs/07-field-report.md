# 07 · 生产实例实测运行报告

> 采集时间：2026-10-24 23:36–23:45 (GMT+8)
> 采集方式：SSH 登录主机 + `docker inspect` + 容器内 HTTP 探活 + SQLite 只读统计
> 敏感信息处理：本文不包含任何密钥、口令、卡密原文或设备标识

## 1. 主机环境

| 项 | 实测值 |
| --- | --- |
| 主机名 | `debian` |
| 系统 | Linux 4.19.0-27-amd64 x86_64（Debian） |
| 内存 | 980 MB 总量 / 336 MB 已用 / 472 MB 可用 |
| 根分区 | 45 G，已用 12 G（28%） |
| Docker 容器数 | 4 个运行中 |
| 项目路径 | `/root/docker/card-service`（4.4 MB，91 个文件） |

内存 980 MB 是一个典型的 1 GB 入门规格 VPS，说明该服务对资源的需求极低 —— 与其他三个容器共存仍有余量。

## 2. 容器拓扑

| 容器 | 镜像 | 状态 | 端口 |
| --- | --- | --- | --- |
| `card-service` | `ghcr.io/heijiji0527/card-service:latest` | Up 5 days (**healthy**) | `0.0.0.0:48192 -> 8080` |
| `nginx` | `nginx` | Up 6 days | `0.0.0.0:22780 -> 80` |
| `npm` | `zoeyvid/nginx-proxy-manager` | 采集时刚启动（health: starting） | — |
| `dashboard-dashboard-1` | `ghcr.io/naiba/nezha-dashboard` | Up 6 days | `5555`, `8008` |

**推断**：主机上同时跑着 Nginx Proxy Manager（`npm`）和原生 `nginx`，通常用于统一入口与证书管理。但 `card-service` 的 48192 端口是**直接发布到 0.0.0.0** 的，即流量存在绕过反代的路径。这一点在 06 文档中被列为 R1 高危项。

## 3. 运行时安全配置（实测 `docker inspect`）

| 项 | 实测值 | 评价 |
| --- | --- | --- |
| `ReadonlyRootfs` | `true` | ✅ 根文件系统只读 |
| `SecurityOpt` | `no-new-privileges:true` | ✅ 禁止提权 |
| `Config.User` | `10001:10001` | ✅ 非 root 运行 |
| `RestartPolicy` | `unless-stopped` | ✅ 支撑网页重启功能 |
| 挂载 | `/root/docker/card-service/data -> /data` (rw) | ✅ 单一可写挂载点，最小化 |
| 镜像大小 | 122 MB | 精简（`python:3.12-slim` 基础镜像） |
| 镜像构建时间 | 2026-10-18 22:32 (-04:00) | 与 v1.1.1 发布节奏一致 |

安全加固项与仓库里的 `docker-compose.yml` 完全对应，说明**部署忠实于代码，没有为了省事关掉加固**。

## 4. 服务健康度

`GET /health` 实测响应：

```json
{"status":"success","message":"","data":{
  "service":"local-card-service",
  "pid":1,
  "uptime":478795,
  "db":"/data/cards.sqlite3"
}}
```

| 指标 | 值 | 换算 |
| --- | --- | --- |
| 进程 PID | 1 | 容器内主进程为 Python，无 shell 包装层 |
| 连续运行 | 478 795 秒 | **5 天 13 小时** |
| 健康检查 | healthy | 30 秒间隔探活全部通过 |

`pid=1` 说明 entrypoint 用 `exec` 移交了进程控制权，能正确接收 `SIGTERM`，这是容器化的正确写法。

## 5. 数据画像

| 表 | 统计 |
| --- | --- |
| `users` | 4 条，**全部为 admin**，无普通用户 |
| `cards` | 98 张 |

卡密状态分布：

| 状态 | 数量 | 占比 |
| --- | --- | --- |
| `active`（已激活） | 63 | 64.3% |
| `unused`（未使用） | 34 | 34.7% |
| `disabled`（已禁用） | 1 | 1.0% |

卡密周期分布：

| 类型 | 数量 | 占比 |
| --- | --- | --- |
| `half_year`（半年卡） | 87 | 88.8% |
| `month`（月卡） | 10 | 10.2% |
| `year`（年卡） | 1 | 1.0% |

数据库文件 60 KB。按此规模，SQLite 距离性能瓶颈极远 —— 即便增长到 10 万张卡，文件也不足 60 MB，查询仍走索引。

**运营观察**：

1. **半年卡是绝对主力**（88.8%），说明实际销售/发放以半年周期为主。若这是商业分发，半年卡是最需要稳定的路径。
2. **激活率 64.3%**，未使用 34.7% 属正常囤积水平（卡密批发后逐步消耗）。
3. **只有 1 张被禁用**，说明封禁不是常规手段 —— 侧面印证了 06 文档 R6 的判断：缺少解绑能力时，管理员倾向于"不处理"而非"删卡"。
4. **4 个账户全是管理员**，无普通用户。这意味着角色分离（user/admin）在实际使用中**未被启用**，所有登录者都拥有删卡、下载数据库备份、触发更新的全部权限。若这 4 个账户由不同人持有，权限过度授予是实质风险。

## 6. 更新链状态

`data/update-state.json` 与 `data/app/.install-source.json` 一致：

```json
{
  "repo": "heijiji0527/card-service",
  "branch": "master",
  "commit": "dc22c37a36be1c4146c0531c8529f42d95e929df",
  "short": "dc22c37",
  "subject": "fix: 修复手机端复制提示成功但剪贴板为空",
  "date": "2026-10-18T19:29:56Z"
}
```

> 📌 **变更说明（2026-10-24 更新）**
> 上表为采集时的原值：该实例当时从上游 `heijiji0527/card-service` 的 `master` 分支更新，镜像为 `ghcr.io/heijiji0527/card-service:latest`。
>
> 此后更新源已更正为 **`quanquna0319/card-service` 的 `main` 分支**，并已完成：
> 1. `CARD_UPDATE_REPO` / `CARD_UPDATE_BRANCH` 写入 `.env` 与 `docker-compose.yml`（此前 compose 已删除这两项注入，容器一直在用镜像内置默认值）；
> 2. 镜像切换为 `ghcr.io/quanquna0319/card-service:latest`（CI 构建，多架构，包可见性 public）；
> 3. 容器重建后运行的是**镜像内** `/app/server.py`（新镜像 `.build-revision` 更新，entrypoint 自动仲裁回镜像代码），`/data/app` 旧副本不再被加载；
> 4. 数据库零变化：98 张卡密（63 激活 / 34 未使用 / 1 禁用）、4 个账户，与切换前一致。
>
> 注意：`/data/update-state.json` 仍保留旧仓库的 `dc22c37` 记录（这是当时安装来源的真实历史），因此切换后首次「检查更新」会显示远端有新提交，属预期行为。

**关键发现：这个实例是 download 模式更新的产物，而非纯镜像运行。**

证据链：

1. `/data/app/` 下存在完整的 `server.py` + `static/` + `.build-revision`；
2. `/data/app/.install-source.json` 记录了来源 commit；
3. `/data/app/.build-revision` 内容为 `dc22c37…`；
4. **`/data/app/server.py` 与宿主机 `/root/docker/card-service/server.py` 的 MD5 完全一致**（`f883f329ac68d67b5ccd576ece728732`）—— 说明网页一键更新拉取的代码与 Git 工作区代码同步，没有出现"容器跑旧代码、磁盘是新代码"的漂移；
5. `update-packages/` 目录为空，说明留存源码包已被轮转清理（或未留存）。

也就是说，v1.1.1 引入的"Docker 一键更新"机制**已在生产实际使用过并生效**，且版本仲裁（镜像 vs 数据卷）工作正常：当前运行的是 `dc22c37` 这份从 GitHub 下载的代码。

`docker-entrypoint.sh` 的版本比较用 mtime 而非内容哈希，在有更新状态下这是可接受的简化，但存在边界情况（如镜像重建后 mtime 早于数据卷文件，会继续用旧副本）。当前实例未受影响。

## 7. 备份状态

| 项 | 值 |
| --- | --- |
| 备份目录 | `/root/docker/card-service/data/backups` |
| 快照数量 | 1 |
| 最新快照 | `cards-manual-20261024-231555-b276.sqlite3`（60 KB） |
| 生成时间 | 2026-10-24 23:15:55 |

只有 1 份手动备份，**没有任何自动快照**。这意味着：

- 网页一键更新虽然是"下载→校验→替换"，但**更新前不会自动备份数据库**（至少本实例未产生 `auto` 标签快照）；
- 一旦误操作恢复错版本，可回退的窗口只有这一份。

**建议**：借助宿主机 cron 每日调用 `GET /api/backup/download` 或用 `sqlite3 .backup` 落一份异地快照；同时在更新流程里强制先快照。

## 8. 实测结论

| 维度 | 结论 |
| --- | --- |
| **稳定性** | 连续运行 5 天 13 小时无异常，健康检查全绿；1 GB 内存主机与其他 3 个容器共存无压力 |
| **部署正确性** | 容器加固项（只读根、非 root、无提权、单挂载点）与仓库配置完全一致；entrypoint 正确 `exec` 到 PID 1 |
| **版本一致性** | 数据卷代码与 Git 工作区 MD5 相同，无版本漂移；一键更新机制已被实际使用 |
| **数据健康** | 98 张卡、60 KB 库，规模远低于 SQLite 瓶颈；激活率 64.3%，半年卡占 88.8% |
| **最大隐患** | 48192 端口直接暴露 HTTP，无 TLS；4 个账户全为管理员，权限未分级 |
| **次大隐患** | 仅 1 份手动备份、无自动快照；更新机制无签名校验 |

## 9. 立即可执行的改进（按投入产出排序）

1. **关 48192 公网口**，改 `127.0.0.1:48192:8080`，用已在跑的 npm/Caddy 反代并上证书 —— 15 分钟，消除最大风险。
2. **把 4 个管理员拆分**：只保留 1–2 个 admin，其余降为 `user`，减少 token 泄露的爆炸半径 —— 后台点两下即可。
3. **加一条每日备份 cron**，快照落盘并异地同步 —— 30 分钟，防误删/误恢复。
4. **登录失败限流**（代码改动约 20 行，内存计数即可） —— 消除在线爆破。
5. **更新固定 commit + 更新前强制快照** —— 收敛供应链风险与可回滚性。
