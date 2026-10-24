# 部署文档

## 一、部署模型

单容器运行。Python 标准库 HTTP 服务提供 `/api/verify_card.php` 与浏览器管理台，静态前端已构建在 `static/` 内，运行时不需要 Node。

容器内关键路径：

| 路径 | 用途 |
| --- | --- |
| `/app/server.py` | 服务入口 |
| `/app/static` | 已构建的前端 |
| `/data/cards.sqlite3` | SQLite 数据库（必须挂载持久卷） |
| `/usr/local/bin/docker-entrypoint.sh` | 启动前校验密钥 |

容器以非 root 用户 `10001:10001` 运行，根文件系统只读，仅 `/data` 与 `/tmp` 可写。

## 二、构建与启动

### 一）本机 Docker

```bash
cp .env.example .env
# 编辑 .env：把 CARD_SECRET 与 CARD_ADMIN_PASSWORD 换成真实值
docker compose up -d --build
curl -fsS http://127.0.0.1:8080/health
```

首次启动会在 `./data/cards.sqlite3` 建库，并按 `CARD_ADMIN_USER` 与 `CARD_ADMIN_PASSWORD` 创建管理员。已有数据库不会覆盖现有账户与卡密。

### 二）仅构建镜像

```bash
docker build -t card-service:local .
docker run -d --name card-service \
  -p 127.0.0.1:8080:8080 \
  -v "$PWD/data:/data" \
  -e CARD_SECRET="$(openssl rand -hex 32)" \
  -e CARD_APP_ID="APP_ID" \
  -e CARD_ADMIN_USER="admin" \
  -e CARD_ADMIN_PASSWORD="换成一个强密码" \
  card-service:local
```

### 三）GitHub Actions 构建并推送 GHCR

推送到 `main` 或打 `v*` 标签后，`.github/workflows/build-image.yml` 会构建 `linux/amd64` 与 `linux/arm64` 两个架构的镜像并推送到：

```text
ghcr.io/quanquna0319/card-service:latest
ghcr.io/quanquna0319/card-service:1.1.2
```

拉取私有包前需要登录：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u quanquna0319 --password-stdin
docker pull ghcr.io/quanquna0319/card-service:latest
```

## 三、环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `CARD_SECRET` | 是 | 无 | 卡密签名密钥，至少 16 字符，建议 64 位随机十六进制 |
| `CARD_ADMIN_PASSWORD` | 是 | 无 | 首次建库时创建的管理员密码，至少 10 字符 |
| `CARD_ADMIN_USER` | 否 | `admin` | 首次建库时的管理员用户名 |
| `CARD_APP_ID` | 否 | `APP_ID` | 客户端验证接口的默认 `app_id` |
| `CARD_DB` | 否 | `/data/cards.sqlite3` | SQLite 路径，容器内必须落在 `/data` |
| `CARD_HOST` | 否 | `0.0.0.0` | 容器内监听地址，镜像内固定为 `0.0.0.0` |
| `CARD_PORT` | 否 | `8080` | 监听端口 |
| `CARD_UPDATE_COMMAND` | 否 | 空 | 维护页“项目更新”在容器内执行的命令；为空时按 Git 仓库模式或提示手动升级 |
| `CARD_UPDATE_REPO` | 否 | `quanquna0319/card-service` | 下载更新使用的 GitHub 仓库 |
| `CARD_UPDATE_BRANCH` | 否 | `main` | 下载更新使用的分支 |
| `CARD_UPDATE_INSTALL_DIR` | 否 | `/data/app` | 网页更新写入的程序目录，必须位于可写卷 |
| `CARD_UPDATE_PACKAGE_DIR` | 否 | `<CARD_DB 所在目录>/update-packages` | 留存更新时从 GitHub 下载的源码包，维护页可下载或删除，最多保留 5 份 |
| `GITHUB_TOKEN` | 否 | 空 | 私有仓库或 API 限流时使用的只读令牌 |
| `TZ` | 否 | `Asia/Shanghai` | 时区 |
| `ALLOW_INSECURE_DEFAULTS` | 否 | `0` | 设为 `1` 才允许使用示例密钥启动，仅限本机试跑 |

启动守卫会拒绝空密钥、示例密钥、短于 16 字符的密钥和短于 10 字符的密码，避免把默认值带上生产。

## 四、端口与反向代理

默认只把端口绑到回环地址：

```yaml
ports:
  - "127.0.0.1:8080:8080"
```

对外发布需要 HTTPS。仓库内提供了可选的 Caddy 配置：

```bash
# .env 中填写
CARD_DOMAIN=card.example.com
ACME_EMAIL=ops@example.com

docker compose --profile tls up -d --build
```

Caddy 会自动申请证书，并把请求转发到 `card-service:8080`。也可以使用已有的 Nginx：

```nginx
server {
    listen 443 ssl http2;
    server_name card.example.com;

    ssl_certificate     /etc/letsencrypt/live/card.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/card.example.com/privkey.pem;

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

上线检查清单：

- 端口只暴露给反向代理，不要直接映射 `0.0.0.0:8080`
- `CARD_SECRET` 与管理员密码不要复用示例值
- 反向代理层开启 HSTS、关闭目录列表、限制请求体大小
- 服务器防火墙只放行 80 与 443

## 五、数据、备份与恢复

管理台新增“维护”页面，管理员可以在浏览器里完成三件事：

1、立即备份并下载：服务端用 SQLite 在线备份接口生成一致性快照，同时留存在备份目录并下载到本机。

2、上传恢复：只接受包含 `cards` 与 `users` 表、且 `integrity_check` 通过的 SQLite 文件；覆盖前自动保存一份安全备份，再用原子替换换入。

3、重启服务：接口返回后进程退出，由 systemd 或容器策略拉起。页面会自动轮询 `/health`，进程号变化即视为重启成功。

相关接口（均要求管理员令牌）：

```text
GET  /api/system
GET  /api/backup/download
GET  /api/backup/file?name=<备份文件名>
POST /api/backup/restore      body 为 SQLite 文件二进制，上限 32 MB
POST /api/restart
```

备份目录默认是数据库同级的 `backups/`，可用 `CARD_BACKUP_DIR` 覆盖，默认保留最近 20 份。

重启依赖进程管理器。systemd 单元必须使用 `Restart=always`，因为网页重启以退出码 0 结束进程；`Restart=on-failure` 不会拉起。仓库内 `deploy/card-service.service` 已按此配置。

不使用管理台时，也可以走命令行。数据库是单个 SQLite 文件，备份前先停写：

```bash
docker compose exec -T card-service \
  python -c "import sqlite3; s=sqlite3.connect('/data/cards.sqlite3'); d=sqlite3.connect('/data/backup.sqlite3'); s.backup(d); d.close(); s.close()"

docker cp card-service:/data/backup.sqlite3 ./backup-$(date +%F).sqlite3
docker compose exec -T card-service rm -f /data/backup.sqlite3
```

恢复：

```bash
docker compose down
cp backup-2026-10-17.sqlite3 ./data/cards.sqlite3
docker compose up -d
```

权限要求：宿主机 `./data` 目录需允许容器内 uid `10001` 写入。Linux 上执行 `sudo chown -R 10001:10001 ./data`。

## 六、升级与回滚

管理台“维护 - 项目更新”可以在页面里直接拉取最新版本：Git 目录运行的服务执行 `git pull --ff-only` 并可自动重启；Docker 镜像没有 Git 时，会通过 GitHub 接口获取最新提交并下载源码包，写入挂载卷的 `app/` 目录，重启后由启动脚本优先加载。只有显式配置 `CARD_UPDATE_COMMAND` 才会改为执行自定义命令。无论哪种方式，升级前先备份数据库。

```bash
# 升级
docker compose pull
docker compose up -d

# 回滚到指定镜像
docker compose down
docker run -d --name card-service ... ghcr.io/quanquna0319/card-service:1.1.2
```

升级前先按上一节备份数据库。数据库结构由服务启动时自动迁移，回滚镜像时如果结构已向前迁移，需要同时回滚数据库备份。

## 七、健康检查与排障

```bash
docker compose ps
docker compose logs -f card-service
curl -fsS http://127.0.0.1:8080/health
```

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动即退出并提示 `refusing to start` | 未设置真实密钥或密码 | 检查 `.env`，或本机试跑时显式设置 `ALLOW_INSECURE_DEFAULTS=1` |
| `sqlite3.OperationalError: unable to open database file` | `/data` 不可写 | 修正宿主机目录所有者或挂载权限 |
| 容器健康但页面 502 | 反向代理指向错误端口 | 确认代理到 `card-service:8080` |
| 登录后重启需要重新登录 | 会话保存在进程内存 | 设计如此，重启后重新登录 |
| 客户端验证返回“卡密已绑定其他设备” | 首次验证已绑定 `app_id` 与 `uuid` | 在管理台编辑该卡密或更换新的卡密 |

## 八、接口冒烟测试

```bash
curl -fsS http://127.0.0.1:8080/health

curl -sS -X POST http://127.0.0.1:8080/api/verify_card.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "card_code=TEST-SERIAL" \
  --data-urlencode "app_id=APP_ID" \
  --data-urlencode "uuid=test-device-0001"
```

返回 `{"status":"error","message":"卡密不存在"}` 说明接口与数据库链路正常。

## 九、已知限制

- 会话令牌保存在服务进程内存，容器重启后全部失效
- SQLite 单文件适合单实例部署，多副本水平扩展需要换成集中式数据库
- 镜像内不包含前端源码与构建工具，前端改动需要在 `frontend/` 下重新构建并提交 `static/`
- 卡密明文用 `CARD_SECRET` 派生的密钥加密后存入 `cards.card_secret`；校验摘要同样依赖该密钥，更换后旧卡密既无法验证也无法回显明文，需要重新生成
- 本机没有可用的 Docker 引擎，本地 `docker build` 未执行；镜像由 GitHub Actions 在容器内完成构建与冒烟测试（`build-image` 工作流，`build` 与 `smoke` 两个任务均通过）
