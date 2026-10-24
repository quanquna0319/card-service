# 03 · 数据模型与卡密算法

## 1. 数据库结构

单个 SQLite 文件（默认 `cards.sqlite3`，Docker 下 `/data/cards.sqlite3`），两张表，无外键关联。

### 1.1 `users`

```sql
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK(role IN ('admin','user')),
    created_at    TEXT NOT NULL,
    disabled      INTEGER NOT NULL DEFAULT 0
);
```

| 字段 | 说明 |
| --- | --- |
| `username` | 唯一索引，长度 3–32（应用层校验） |
| `password_hash` | `scrypt$<hex salt>$<hex digest>`，见 2.1 |
| `role` | 数据库级 `CHECK` 约束，只有 `admin` / `user` |
| `created_at` | UTC ISO8601，形如 `2026-10-24T15:36:03Z` |
| `disabled` | 0/1，登录时 `WHERE ... AND disabled=0` 直接过滤 |

### 1.2 `cards`

```sql
CREATE TABLE IF NOT EXISTS cards (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    card_hash    TEXT NOT NULL UNIQUE,      -- HMAC 摘要，查表键
    card_secret  TEXT,                      -- 加密后的卡密明文（可空=旧数据）
    card_type    TEXT NOT NULL CHECK(card_type IN ('month','half_year','year')),
    status       TEXT NOT NULL CHECK(status IN ('unused','active','disabled')),
    created_at   TEXT NOT NULL,
    activated_at TEXT,
    expire_time  TEXT,
    device_uuid  TEXT,
    app_id       TEXT,
    note         TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS cards_device_idx ON cards(device_uuid);
```

**双列设计是理解这张表的关键**：

| 列 | 用途 | 特性 |
| --- | --- | --- |
| `card_hash` | 验证时按卡号查表 | HMAC 单向摘要，不可逆；`UNIQUE` 保证卡号不重复 |
| `card_secret` | 让管理员回看/复制明文 | 用 `SECRET` 派生密钥流加密，密钥变更后无法解密 |
| `note` | 运营备注 | ≤ 80 字符，可为空 |

为什么不用一列存明文？因为 `card_hash` 参与索引与比对，泄露后无法反推卡号；而明文只在管理员主动查看时由服务端解密下发。即便数据库文件单独泄露（未拿到 `CARD_SECRET`），攻击者也拿不到可用卡号。

`cards_device_idx` 支撑"按设备查卡"的潜在查询，当前代码主路径走 `card_hash` 唯一索引。

### 1.3 迁移策略

`migrate_database()` 对**任何**传入的库文件执行同一套幂等迁移：

1. `CREATE TABLE IF NOT EXISTS` 建表与索引；
2. `PRAGMA table_info(cards)` 取现有列集合；
3. 缺 `note` → `ALTER TABLE ADD COLUMN note TEXT DEFAULT ''`；
4. 缺 `card_secret` → `ALTER TABLE ADD COLUMN card_secret TEXT`（旧版只存摘要，无法反推）；
5. 若存在中间版本的 `card_code` 明文列 → 逐行 `seal_code()` 迁入 `card_secret` 后置 `card_code=NULL`，**主动清除历史明文残留**。

第 5 步说明作者意识到了"明文列"的历史债务，并在迁移时主动清理 —— 这是个值得肯定的细节。

## 2. 三个密码学构件

### 2.1 管理员口令：scrypt

```python
def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt${salt.hex()}${digest.hex()}"
```

| 参数 | 值 | 含义 |
| --- | --- | --- |
| `n` | 2^14 = 16384 | CPU/内存成本（约 16 MB） |
| `r` | 8 | 块大小 |
| `p` | 1 | 并行度 |
| salt | 16 字节随机 | 每用户独立，防彩虹表 |

校验用 `hmac.compare_digest()` 做**常数时间比较**，避免时序侧信道。参数强度对交互式登录足够（约 50–100 ms），对离线爆破有实质成本。

### 2.2 卡号生成：B32 随机 + 校验位

```python
def make_card() -> str:
    raw = base64.b32encode(secrets.token_bytes(10)).decode().rstrip("=")   # 16 字符
    check = base64.b32encode(
        hmac.new(SECRET, raw.encode(), hashlib.sha256).digest()[:3]
    ).decode()[:4]                                                         # 4 字符
    return f"{raw[:4]}-{raw[4:8]}-{raw[8:12]}-{raw[12:16]}-{check}"
```

输出形态：`XXXX-XXXX-XXXX-XXXX-XXXX`（5 组 × 4 字符 = 20 字符 + 4 个连字符）。

| 部分 | 长度 | 来源 | 作用 |
| --- | --- | --- | --- |
| 前 16 字符 | 80 bit 随机 | `secrets.token_bytes(10)` 后 Base32 | 不可预测的卡号主体 |
| 末 4 字符 | 20 bit 截断 | HMAC-SHA256(`SECRET`, raw) 前 3 字节再 Base32 | 校验位，防止伪造/手误 |

**安全性评估**：80 bit 随机熵意味着暴力枚举不可行（即使按 10 万次/秒也要 10^17 年量级）。校验位让服务端可以在查库前先剔除格式错误的输入，也让人工输入笔误能被即时发现。

注意实际实现中**校验位并未在 `verify_card()` 里预先校验** —— 验证直接走 `digest()` 查表，`check` 段仅作为格式一部分参与 HMAC。这意味着校验位当前是"形式上的"而非"功能上的"，属于可改进点（见 06 文档）。

### 2.3 卡号摘要与明文加解密

```python
def digest(card_code):                      # 查表键
    return hmac.new(SECRET, card_code.encode(), hashlib.sha256).hexdigest()

def seal_code(card_code):                   # 加密明文
    nonce = secrets.token_bytes(12)
    key = hmac.new(SECRET, b"card-secret-v1", hashlib.sha256).digest()
    stream = b""
    counter = 0
    while len(stream) < len(data):
        stream += hmac.new(key, nonce + counter.to_bytes(4,"big"), hashlib.sha256).digest()
        counter += 1
    return base64.urlsafe_b64encode(nonce + xor(data, stream))
```

`seal_code` 是一个**自制的 HMAC-CTR 流密码**：

```
key    = HMAC-SHA256(CARD_SECRET, "card-secret-v1")     ← 领域分离标签
nonce  = 12 字节随机（每次加密不同）
keystream = HMAC(key, nonce ‖ counter) 拼接             ← 类比 CTR 模式
cipher = plaintext XOR keystream
输出   = base64url(nonce ‖ cipher)
```

设计要点：

- **领域分离**：`b"card-secret-v1"` 作为标签，使加密密钥与 `digest()` 使用的密钥互相独立，避免同密钥跨用途复用。
- **随机 nonce**：同一卡号每次加密结果不同，防止库内模式泄露。
- **密钥即 `CARD_SECRET`**：加密密钥由 `CARD_SECRET` 派生，因此密钥变更会让所有历史 `card_secret` 无法解密（`open_code()` 返回 `None`），表现为管理员看不到旧卡号明文。

> ⚠️ **重要运维事实：`CARD_SECRET` 不可轮换。**
> `digest()` 同样依赖 `CARD_SECRET`。更换它会导致所有既有 `card_hash` 全部失配，**所有卡密立即验证失败**（客户端收到"卡密不存在"），且旧明文也无法解密 —— 等于数据永久作废。
> 因此 `CARD_SECRET` 必须在首次投产前确定，之后视同数据本身对待：纳入密钥备份、不随版本升级变更、迁移服务器时与数据库一同搬走。

- **缺少完整性保护**：这是纯流加密，没有 MAC/AEAD。理论上攻击者可对密文做比特翻转，使 `open_code()` 解出错误卡号。但由于 `card_secret` 仅用于"管理员回看"，验证路径走的是 `card_hash`，且能写库者已具备更高权限，实际风险很低。若追求严谨，可改用 AES-GCM 或 HMAC-then-Encrypt。

## 3. 状态机与不变量

### 3.1 三状态

| 状态 | 含义 | 进入条件 |
| --- | --- | --- |
| `unused` | 未激活，尚未开始计时 | 生成时（未指定固定到期） |
| `active` | 已激活，绑定设备 | 首次成功验证；或管理员重新启用 |
| `disabled` | 管理员封禁 | `POST /api/cards/toggle` |

### 3.2 状态迁移

```
生成 ──► unused ──首次验证──► active ──到期──► (仍为 active，但验证返回"已过期")
            ▲                   │
            │                   │ 管理员 toggle
            └──── toggle ───────┤
                                ▼
                            disabled ──toggle──► active 或 unused
```

`toggle` 的"恢复"逻辑很务实：

```python
if row["status"] != "disabled":
    status = "disabled"
else:
    expiry = parse_time(row["expire_time"])
    status = "active" if row["device_uuid"] and row["app_id"] and expiry and expiry > now() else "unused"
```

即：**只有曾激活且未过期、且绑定信息完整的卡，才恢复为 `active`；否则退回 `unused`（重新计时）**。这避免了"解封一张过期卡却仍显示已激活"的状态错乱。

### 3.3 关键不变量

| 不变量 | 保证方式 |
| --- | --- |
| 卡号唯一 | `card_hash UNIQUE` + 插入冲突重试 5 次重新生成 |
| 一卡一机 | 首次验证写 `device_uuid`+`app_id`，之后严格比对 |
| 到期不延长 | 重复验证只读取 `expire_time`，不重写 |
| 未激活不计时 | `expire_time` 为空时不写值，等首次验证才计算 |
| 已激活卡必须有到期时间 | `update` 接口拒绝把 `active` 卡的 `expire_time` 改为空 |
| 管理员不能停用自己 | `users/toggle` 检查 `user_id == 当前用户 id` |

## 4. 时区与时间精度

全链路统一 UTC：

- `now()` = `datetime.now(timezone.utc)` 且 `microsecond=0`（截断到秒）；
- `iso()` 输出 `...Z` 后缀；
- `parse_time()` 对无时区字符串按 UTC 解释，再统一转 UTC。

这个设计避免了"服务器部署在 Asia/Shanghai、客户端在 UTC"这类场景下的到期时间漂移，也让 `TZ` 环境变量只影响日志显示、不影响业务计算。

## 5. 备份数据形态

备份目录（`CARD_BACKUP_DIR`，默认库同级 `backups/`）内每次快照为：

```
cards-<label>-<YYYYmmdd-HHMMSS>-<4位随机>.sqlite3
例：cards-manual-20261024-231555-b276.sqlite3
```

- `label` 取值 `manual` / `auto` 等，区分触发来源；
- 由 `snapshot_database()` 用 SQLite 在线备份 API 生成，**保证事务一致**；
- `prune_backups(keep=20)` 自动轮转，避免无限增长；
- 恢复时 `restore_database()` 会先校验文件头是否合法 SQLite、写入临时文件、执行迁移、再原子替换，**并保留回滚窗口**。
