# Vault 密码库 · apiSQL 接口文档

> 适用后端：第三方面板 **apiSQL**（open.apisql.cn）的「SQL 类型接口」 + MySQL
> 前端已就绪（`api.js` 的 `ApisqlStore`），只需在本平台按下列规则建好接口，再把 `config.js` 的 `mode` 改为 `"apisql"` 并填入 `base/key` 即可。

---

## 一、平台调用规则（必读）

1. **请求方法：仅 `GET`**（POST 会 404）。
2. **参数格式：`params[名称]=值`**，且必须放在 Query String。
   - ✅ `GET /entry_save?params[id]=T1&params[name]=GitHub`
   - ❌ `GET /entry_save?id=T1&name=GitHub`（平台收不到，`:参数` 会被替换成空串，整数列直接报错）
3. **鉴权头**：`Authorization: Bearer <API_KEY>`。
4. **避免传 `0`**：apiSQL 把 `0` 当作「未提供」。布尔型（`fav`/`deleted`）改用 `TINYINT` 且用 **1/2** 表示（1=是，2=否），不要写 0。
5. **接口 SQL 必须是单条语句**：apiSQL 以预处理单语句执行，`;` 后接第二条语句会报 500 语法错误（`cat_save` 曾踩此坑）。需要多步操作时拆成多个接口或由前端多次调用组合完成。
6. **平台参数类型只有 5 种**：`string` / `number` / `boolean` / `datetime` / `time`（接口「API参数」页里选）。本文档的 MySQL 列类型按此映射：VARCHAR/TEXT → `string`，TINYINT 计数 → `number`，布尔语义 → `boolean`，DATETIME → `datetime`。
7. **datetime 列回读为 UTC ISO 格式**（如 `2026-10-25T07:35:45.000Z`，按 UTC+8 折算）：写入传本地时间 `YYYY-MM-DD HH:MM:SS` 即可，前端 `api.js` 的 `toLocalDT()` 已负责回读时转回本地时间。
8. **响应**：
   - 查询：`{ "meta": {...}, "rows": [ {字段...} ] }`
   - 写操作：`{ "info": { "affectedRows": 1, ... }, "meta": {...}, "rows": [] }`
   - 出错：`{ "code": "API_GATEWAY_SERVER_ERROR", "message": "..." }`（HTTP 200 也可能带错误体，需判 `code`）。
6. **前端通用调用函数**（见文末附录）。

---

## 二、数据库表结构（MySQL）

```sql
CREATE TABLE pv_entry (
  id          VARCHAR(36)  PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  user        VARCHAR(128),                -- 只存占位符（账号已并入 pw 列密文）
  pw          TEXT,                        -- 账号+密码合并加密后的密文（v1:base64url）
  cat         VARCHAR(64),
  note        TEXT,
  url         VARCHAR(256),
  fav         TINYINT      NOT NULL DEFAULT 2,  -- 1=收藏, 2=未收藏（不用 0）
  deleted     TINYINT      NOT NULL DEFAULT 2,  -- 1=已删除, 2=正常（不用 0）
  updated_at  DATETIME
);

CREATE TABLE pv_cat (
  name        VARCHAR(64) PRIMARY KEY,
  sort        TINYINT      NOT NULL DEFAULT 2
);
```

> 账号/密码由前端用主密码派生的 AES-256-GCM 密钥加密后再传：两者合并为一个密文（`v1:` 前缀 + base64url(IV∥密文)）写入 `pw` 列，`user` 列只存占位符——MySQL 里没有任何明文账号密码；`name`/`url`/`cat`/`note` 按明文存储。主密码、salt、verifier 不入库（存浏览器 localStorage 本地校验）。旧版明文行在下次解锁时自动转存为密文。

---

## 三、接口清单

### 1. 列出全部条目 `entry_list`

| 项 | 值 |
|---|---|
| 接口名 | `entry_list` |
| 方法 | GET |
| 参数 | 无 |
| 返回 | 正常且未删除的条目数组 |

**平台 SQL：**
```sql
SELECT id, name, user, pw, cat, note, url, fav, deleted, updated_at
FROM pv_entry
WHERE deleted = 2;
```

---

### 2. 保存/更新条目 `entry_save`（新增或覆盖）

| 项 | 值 |
|---|---|
| 接口名 | `entry_save` |
| 方法 | GET |
| 说明 | 按 `id` 主键 upsert；`fav/deleted` 传 `1` 或 `2` |

**参数类型：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | VARCHAR(36)（平台：string） | 条目主键（必填） |
| `name` | VARCHAR(128)（平台：string） | 名称（必填） |
| `user` | VARCHAR(128)（平台：string） | 账号（可空，空传 `" "`） |
| `pw` | TEXT（平台：string） | AES 密文（必填） |
| `cat` | VARCHAR(64)（平台：string） | 分类 |
| `note` | TEXT（平台：string） | 备注密文（可空，空传 `" "`） |
| `url` | VARCHAR(256)（平台：string） | 网址 |
| `fav` | TINYINT（平台：number） | 1=收藏, 2=未收藏 |
| `deleted` | TINYINT（平台：number） | 1=已删, 2=正常 |
| `updated_at` | DATETIME（平台：datetime） | `YYYY-MM-DD HH:MM:SS`（必传，不传会 500）；回读为 UTC ISO，前端已本地化 |

**平台 SQL：**
```sql
INSERT INTO pv_entry (id, name, user, pw, cat, note, url, fav, deleted, updated_at)
VALUES (:id, :name, :user, :pw, :cat, :note, :url, :fav, :deleted, :updated_at)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), user = VALUES(user), pw = VALUES(pw), cat = VALUES(cat),
  note = VALUES(note), url = VALUES(url), fav = VALUES(fav),
  deleted = VALUES(deleted), updated_at = VALUES(updated_at);
```

> `note`/`url` 为空时前端传一个空格 `" "`（避免空串被平台当作缺失；解密端对空白做 trim）。

---

### 3. 删除条目 `entry_delete`（软删除）

| 项 | 值 |
|---|---|
| 接口名 | `entry_delete` |
| 方法 | GET |
| 说明 | 置 `deleted=1`；不真正删行，便于回收站/恢复 |

**参数类型：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | VARCHAR(36)（平台：string） | 待删除条目主键（必填） |

**平台 SQL：**
```sql
UPDATE pv_entry SET deleted = 1, updated_at = NOW() WHERE id = :id;
```

---

### 4. 恢复条目 `entry_restore`（可选）

| 项 | 值 |
|---|---|
| 接口名 | `entry_restore` |
| 方法 | GET |
| 参数类型 | `id` VARCHAR(36)（待恢复条目主键，必填） |

**平台 SQL：**
```sql
UPDATE pv_entry SET deleted = 2, updated_at = NOW() WHERE id = :id;
```

---

### 4b. 物理删除条目 `entry_purge`（回收站「永久删除」用，需新建）

| 项 | 值 |
|---|---|
| 接口名 | `entry_purge` |
| 方法 | GET |
| 参数类型 | `id` VARCHAR(36)（要永久删除的条目主键，必填） |

**平台 SQL：**
```sql
DELETE FROM pv_entry WHERE id = :id;
```

> 前端「永久删除」会优先调本接口；**平台未建此接口时**，删除仅本地生效，
> 刷新后该条目会重新出现在回收站（此时需在平台补建本接口）。

---

### 5. 列出分类 `cat_list`

| 项 | 值 |
|---|---|
| 接口名 | `cat_list` |
| 方法 | GET |
| 参数 | 无 |
| 返回 | `[ { name } ]` |

**平台 SQL：**
```sql
SELECT name FROM pv_cat ORDER BY sort, name;
```

---

### 6. 保存分类 `cat_save`（新增）

| 项 | 值 |
|---|---|
| 接口名 | `cat_save` |
| 方法 | GET |
| 说明 | 单语句 upsert：新增分类，或给已存在分类刷新 sort |

**参数类型：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | VARCHAR(64)（平台：string） | 分类名称（必填） |

**平台 SQL（必须是单条语句）：**
```sql
INSERT INTO pv_cat (name, sort) VALUES (:name, 2)
ON DUPLICATE KEY UPDATE sort = 2;
```

> **重命名/删除分类由前端 diff 完成**（`api.js` 的 `save`）：保存前先 `cat_list` 取线上分类——本地有、线上没有的调 `cat_save` 新增；线上有、本地没有的（重命名产生的旧名、被删的分类）调 `cat_delete` 清理。因此本接口不需要 `old_name` 参数，也不要在 SQL 里写 `UPDATE ...; INSERT ...` 两条语句（平台会报 500）。

---

### 7. 删除分类 `cat_delete`

| 项 | 值 |
|---|---|
| 接口名 | `cat_delete` |
| 方法 | GET |
| 说明 | 删除分类行；其下条目的 `cat` 建议先迁移到「默认」分类 |

**参数类型：**

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | VARCHAR(64)（平台：string） | 待删除分类名称（必填） |

**平台 SQL：**
```sql
DELETE FROM pv_cat WHERE name = :name;
```

---

## 四、错误与重试

- 任何返回体含 `code` 且不等于 `OK`/`SUCCESS` → 视为失败，抛 `message`。
- 网络层失败或解密失败 → 提示用户「数据解密失败：密钥不匹配或数据已损坏」。
- 建议前端在 `save` 失败时对整包做重试（逐条写，单条失败不中断其余）。

---

## 五、安全规范

1. **API_KEY 不写进源码/仓库**：用 Cloudflare Pages「环境变量 + 构建注入」或部署时注入 `window.VAULT_CONFIG.apisql.key`；`config.js` 中保持空字符串。
2. **配 IP 白名单**：在 apiSQL 平台给接口配置调用方出口 IP，防止 Key 泄露后被滥用。
3. **密文不出本地密钥**：账号/密码在浏览器用主密码派生的 AES-256-GCM 加密（合并密文存 `pw` 列，`user` 列只存占位符），服务端与数据库里没有任何明文账号密码；主密码与派生密钥不持久化、不落库。
4. **定期备份**：MySQL/SqlPub 数据定期导出；前端「设置 → 导出备份」可离线留存加密包。

---

## 六、附录：前端通用调用函数（已内置 `api.js`）

```js
async function apiCall(cfg, iface, params = {}) {
  const base = cfg.base.replace(/\/+$/, "");
  const url = new URL(base + "/" + iface);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set("params[" + k + "]", v);
  });
  const res = await fetch(url, {
    method: "GET",
    headers: { "Authorization": "Bearer " + cfg.key, "Accept": "application/json" }
  });
  const data = await res.json().catch(() => ({}));
  if (data.code && data.code !== "OK" && data.code !== "SUCCESS")
    throw new Error(data.message || data.code);
  return data.rows || data.data || [];
}
```

### `config.js` 对接片段
```js
window.VAULT_CONFIG = {
  mode: "apisql",
  apisql: {
    base: "https://open.apisql.cn/api/weternal_pwd",
    key: "（部署时注入，勿硬编码）",
    endpoints: {
      list: "entry_list", save: "entry_save", delete: "entry_delete",
      restore: "entry_restore", purge: "entry_purge", cats: "cat_list",
      catSave: "cat_save", catDel: "cat_delete"
    }
  }
};
```

## 七、部署到 Cloudflare Pages 时的密钥安全（重要）

**不要把 API_KEY 写进 `config.js`**——静态文件对全网可见，F12 即可拿到密钥。推荐用 Pages Function 代理（仓库已带 `functions/proxy/[iface].js`）：

```
浏览器 ──同源 /proxy/entry_list?params[...]──► Pages Function ──带 Bearer 密钥──► apiSQL
```

- `config.js` 只填 `proxy: "/proxy"`，`base`/`key` 留空；
- 密钥配在 Cloudflare  Dashboard → Pages 项目 → Settings → Environment variables，变量名 **`VAULT_API_KEY`**（加密存储，不进仓库、不进前端）；
- 附带好处：同源请求无 CORS 问题；函数内置接口名白名单，不会被当成开放代理；
- 注意：用了代理就**不要**在 apiSQL 配 IP 白名单（Cloudflare 出口 IP 不固定，会被拦）。

详细部署步骤见 `DEPLOY.md`。
