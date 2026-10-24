# 04 · 接口文档

## 0. 通用约定

| 项 | 约定 |
| --- | --- |
| Base URL | `http://<host>:<port>`（Docker 默认映射 `48192→8080`） |
| 编码 | 请求支持 `application/x-www-form-urlencoded` 与 `application/json`，自动识别 |
| 请求体上限 | 1 MB（超出抛错 → 400） |
| 鉴权 | `Authorization: Bearer <token>`，token 由 `/api/login` 下发 |
| 会话有效期 | 12 小时，访问时滑动续期；**存于进程内存，重启即失效** |
| 响应封装 | `{"status":"success|error","message":"...","data":{...}}`（部分接口字段直接平铺，见各节） |
| 缓存 | 所有 JSON 响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff` |
| 时间格式 | UTC ISO8601，如 `2026-10-24T15:36:03Z` |

**HTTP 状态码语义**

| 码 | 含义 |
| --- | --- |
| 200 | 成功；**卡密验证失败也返回 200**，靠 `status` 字段区分（兼容既有客户端） |
| 400 | 参数缺失/非法（如 `count` 越界、`expire_time` 不在未来） |
| 401 | 未登录、token 无效或过期 |
| 403 | 已登录但非管理员 |
| 404 | 资源不存在 |
| 409 | 用户名已存在 |
| 500 | 服务端异常（**异常原文会回传给客户端**） |

## 1. 客户端验证接口

### `POST /api/verify_card.php`

> 鉴权：无。这是唯一给客户端调用的接口。

**请求**（form-urlencoded）

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `card_code` | ✅ | 卡密，形如 `XXXX-XXXX-XXXX-XXXX-XXXX` |
| `app_id` | ✅ | 应用标识，需与生成时的 `CARD_APP_ID` 语义一致 |
| `uuid` | ✅ | 设备唯一标识，首次验证时绑定 |

```bash
curl -X POST http://127.0.0.1:8080/api/verify_card.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "card_code=ABCD-EFGH-IJKL-MNOP-QRST" \
  --data-urlencode "app_id=wqx" \
  --data-urlencode "uuid=device-abc-123"
```

**成功响应**

```json
{
  "status": "success",
  "message": "验证成功",
  "data": {
    "expire_time": "2027-04-23T15:36:03Z",
    "app_notice": ""
  }
}
```

**失败响应**（HTTP 均为 200，缺参数时 400）

| `message` | 触发条件 |
| --- | --- |
| `card_code, app_id and uuid are required` | 任一参数为空（HTTP 400） |
| `卡密不存在` | `card_hash` 查不到记录 |
| `卡密已禁用` | `status = disabled` |
| `卡密已过期` | 已到期 |
| `卡密已绑定其他设备` | `device_uuid` 或 `app_id` 与首次验证不一致 |

**行为要点**

- 首次验证：写入 `status=active`、`activated_at`、`expire_time`、`device_uuid`、`app_id`，返回新算出的到期时间。
- 再次验证：只校验不写入，**不会重置或延长**到期时间。
- 固定到期卡：`expire_time` 生成时已定，首次验证仅完成绑定。

## 2. 认证接口

### `POST /api/login`

> 鉴权：无

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `username` | ✅ | 用户名 |
| `password` | ✅ | 密码 |

```json
// 200
{"status":"success","message":"","data":{"token":"<43字符 urlsafe>","user":{"id":1,"username":"admin","role":"admin"}}}
// 401
{"status":"error","message":"用户名或密码错误"}
```

> 注意：响应把 `token` 与 `user` 放在 `data` 里。

### `POST /api/logout`

> 鉴权：登录。从 `SESSIONS` 中删除当前 token，幂等。

### `GET /api/me`

> 鉴权：登录。返回当前用户 `{id, username, role}`。

## 3. 只读接口

### `GET /health`

> 鉴权：无。容器健康检查与探活用。

```json
{"status":"success","message":"","data":{"service":"local-card-service","pid":1,"uptime":478795,"db":"/data/cards.sqlite3"}}
```

### `GET /api/dashboard`

> 鉴权：登录。

```json
{"status":"success","message":"","data":{"stats":{"cards":98,"active":63,"unused":34,"users":4}}}
```

### `GET /api/cards`

> 鉴权：登录。返回**全部**卡密（无分页），按 `id DESC` 排序。

```json
{"status":"success","message":"","data":{"cards":[
  {
    "id": 98,
    "card_code": "ABCD-EFGH-IJKL-MNOP-QRST",
    "card_type": "half_year",
    "status": "active",
    "created_at": "2026-10-18T01:02:03Z",
    "activated_at": "2026-10-18T02:00:00Z",
    "expire_time": "2027-04-16T02:00:00Z",
    "device_uuid": "device-abc-123",
    "app_id": "wqx",
    "note": "渠道A"
  }
]}}
```

**权限差异（重要）**：`card_code` 字段仅对管理员解密回显；普通用户该字段恒为 `null`，且**不下发密文 `card_secret`**。

### `GET /api/users`

> 鉴权：**管理员**。返回 `{id, username, role, created_at, disabled}` 列表（**不含密码哈希**）。

### `GET /api/system`

> 鉴权：**管理员**。维护页数据源，聚合项较多：

```json
{"status":"success","message":"","data":{
  "pid": 1, "uptime": 478795,
  "db": "/data/cards.sqlite3", "db_size": 61440, "db_sha256": "…",
  "backup_dir": "/data/backups", "backups": [{"name":"cards-manual-….sqlite3","size":61440,"mtime":"…"}],
  "git": {"mode":"download","commit":"dc22c37","subject":"…","date":"…"},
  "update_mode": "download",
  "update_repo": "quanquna0319/card-service",
  "update_branch": "main",
  "update_package_dir": "/data/update-packages",
  "update_packages": [{"name":"card-service-dc22c37.tar.gz","size":…}],
  "changelog": {"version":"1.2.0","date":"2026-10-25","entries":[…]}
}}
```

## 4. 卡密管理（全部要求管理员）

### `POST /api/cards/generate`

| 字段 | 必填 | 默认 | 约束 |
| --- | --- | --- | --- |
| `card_type` | | `month` | `month` / `half_year` / `year` |
| `count` | | `1` | 1–1000 |
| `note` | | `""` | ≤ 80 字符 |
| `expire_time` | | 空 | ISO8601，必须是未来；留空 = 首次验证才计时 |

```json
// 200
{"status":"success","message":"","data":{"cards":["ABCD-…","EFGH-…"],"card_type":"month","expire_time":null}}
```

生成采用"插入冲突重试 5 次"策略保证唯一性，任一插入失败会抛出 `could not allocate a unique card code`。

### `POST /api/cards/update`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 卡密 id |
| `note` | | 新备注（≤ 80） |
| `expire_time` | | 新到期时间，未来；**已激活卡不允许改为空** |

### `POST /api/cards/toggle`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 卡密 id |

非 `disabled` → 变为 `disabled`；`disabled` → 若曾激活且未过期则回 `active`，否则回 `unused`。响应返回新 `status`。

### `POST /api/cards/delete`

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `ids` | ✅ | 逗号分隔的 id 串，如 `"1,2,3"`；去重，最多 1000 个 |

```json
// 200
{"status":"success","message":"已删除 3 张卡密","data":{"deleted":3,"missing":0}}
```

删除操作会向 stdout 打印审计行：`admin=<name> deleted=<n> ids=<...>`。

## 5. 账户管理（全部要求管理员）

### `POST /api/users/create`

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `username` | ✅ | 3–32 位 |
| `password` | ✅ | 8–256 位 |
| `role` | | `user`（默认）/ `admin` |

用户名重复返回 **409**。

### `POST /api/users/toggle`

启用/停用指定账户；**不能停用自己**（返回 400 `不能禁用当前管理员`）。

## 6. 运维接口（全部要求管理员）

### `GET /api/backup/download`

即时生成一份新快照并直接以附件下载。

### `GET /api/backup/file?name=<文件名>`

下载指定历史备份。文件名只允许备份目录内的 `.sqlite3`，拒绝 `../`、反斜杠、绝对路径。

### `POST /api/backup/restore`

Body 为 SQLite 文件原始字节（≤ 32 MB）。服务端校验文件头 → 写临时文件 → 迁移 → 原子替换 → 返回结果。

### `POST /api/backup/delete`

```json
{"name": "cards-manual-20261024-231555-b276.sqlite3"}
```

`name` 传空、`*` 或 `all` 时清空全部备份。**只删备份，不动在用数据库。**

### `POST /api/restart`

1 秒后以退出码 0 结束进程，由外部进程管理器拉起。需要 `restart: unless-stopped`（Docker）或 `Restart=always`（systemd）配合，否则会真的停服。

### 更新相关

| 接口 | 说明 |
| --- | --- |
| `GET /api/update/check` | 只读比对远端，返回新提交标题、变化文件数、工作区是否脏 |
| `POST /api/update` | 执行更新，body `{"restart":"0|1"}` 控制是否自动重启 |
| `GET /api/changelog` | 读取本地 `CHANGELOG.md` 并结构化，不依赖网络 |
| `GET /api/update/package?name=` | 下载留存的源码包 |
| `POST /api/update/package/delete` | 删除留存包，`name` 为空则清空 |

## 7. 静态资源

`GET /` 与 `GET /index.html` → `static/index.html`；其余路径按 `static/<path>` 提供。

| 特性 | 实现 |
| --- | --- |
| 目录穿越防护 | `(STATIC / relative).resolve()` 后 `relative_to(STATIC.resolve())`，越界返回 404 |
| 缓存策略 | `assets/*` 带哈希 → `max-age=31536000, immutable`；入口文件 → `no-cache` |
| MIME | `mimetypes.guess_type()`，未知类型回退 `application/octet-stream` |

> 前端无 SPA 路由回退：直接访问不存在的深层路径会 404，因为视图切换由前端状态管理、无需 URL 路由。
