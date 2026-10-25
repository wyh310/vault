# Vault 部署到 Cloudflare · 详细步骤

> 目标：把 `vault-app/` 发布成一个带 HTTPS 的网站，数据经 apiSQL 读写 MySQL，
> **API 密钥放在 Cloudflare 环境变量里，不进仓库、不进前端代码**。
>
> 本方案适合**本地没有 git** 的情况：全程网页操作，不用一行命令行。
> 主推 **方式一：Pages 连接 GitHub 仓库**（「导入现有 Git 存储库」实际落地为 Pages 项目，
> `functions/` 代理生效，推送即自动部署）；不上 GitHub 时用方式二手动上传。

---

## 〇、部署前确认（都已就绪）

| 项 | 状态 |
|---|---|
| apiSQL 8 个接口 | ✅ 全部实测通过（18/18） |
| `functions/proxy/[iface].js`（Pages 代理函数，8 接口白名单） | ✅ 已写好，已推仓库 |
| `api.js` 代理模式 | ✅ 已支持（`config.js` 填 `proxy: "/proxy"` 即用） |
| `worker.js` + `wrangler.toml`（Worker 备选方案） | ✅ 已写好，已推仓库 |
| apiSQL 接口 IP 白名单 | ⚠️ **不要开**（开了会拦 Cloudflare 出口 IP，见文末注意事项） |

---

## 一、方式一（推荐）：Workers Builds · 导入现有 Git 存储库（全自动）

## 一、方式一（推荐）：Pages 连接 GitHub 仓库（Git 导入，全自动）

> 2026-10-25 实测走通的主方案。Cloudflare「创建 Worker」页面选 **「导入现有 Git 存储库」**
> （**别选「拖放文件」**——那是 assets-only 上传，脚本不执行，已实测死路，见文末「最终定论」）。
> 实测该流程落地为 **Pages 项目**（域名 `xxx.pages.dev`），`functions/` 目录生效，
> `/proxy/*` 由 Pages Functions 代理——这正是我们要的。

前提（已就绪）：仓库 `wyh310/vault` 里已有 `functions/proxy/[iface].js`（代理函数）。
`upload_github.py` 会随代码一起推送它；仓库里的 `worker.js`/`wrangler.toml` 是 Worker 备选方案，Pages 路线用不到但无害。

### 第 1 步：开始导入

Workers & Pages → **Create** → 「创建 Worker」页面 → 点 **「导入现有 Git 存储库」** 右侧的 **开始使用**。

### 第 2 步：授权并选仓库

1. 弹出 GitHub 授权页 → 授权 Cloudflare（建议 Only select repositories → 只选 `vault` 仓库）；
2. 选中 `wyh310/vault` → **Begin setup**。

### 第 3 步：构建设置（全部保持默认）

| 配置项 | 值 |
|---|---|
| 框架预设 | **无** |
| 构建命令 | **留空** |
| 构建输出目录 | **`/`**（文件在仓库根目录） |

点 **保存并部署**，等 1~2 分钟。项目名可能被自动加随机后缀（如 `vault-7ft`，因为 `vault`
被旧 Worker 占用了）——正常现象，不影响使用。

### 第 4 步：配 API 密钥（不做会报 500 `NO_KEY`）

Pages 项目 → **Settings → Environment variables → Add variable**：

| 字段 | 值 |
|---|---|
| Variable name | `VAULT_API_KEY` |
| Value | `sk-af8740236c657974ec561c4f0363ac42` |
| Environment | **Production**（建议同时勾 Preview） |

保存后到 **Deployments → 最新部署右侧 ⋯ → Retry deploy**（环境变量必须重新部署才生效）。

### 第 5 步：验证代理

打开 `https://<项目名>.pages.dev/proxy/entry_list`：

- 返回 JSON（`{"code":"OK",...}` 或缺参数的业务报错）→ **通了**；
- **500 `NO_KEY`** → 第 4 步没做或没 Retry deploy；
- **404** → `functions/` 没进部署：确认仓库根目录有 `functions/proxy/[iface].js`。

### 第 6 步：搬域名（第 5 步通过后再做）

1. 旧 assets-only Worker → Settings → 域和路由 → 把要用的域名**移除**；
2. 本 Pages 项目 → **Custom domains → Set up a domain** → 添加域名（如 `wyh.weternal.cc.cd`）；
3. 等几分钟生效。

> **全程不要先删旧 Worker**——域名绑定会跟着丢（Error 1016 / NXDOMAIN 就是这么来的）。

### 以后更新（全自动，不用再回 Cloudflare）

改本地 `vault-app/` 里的文件 → 跑 `upload_github.py` 推送 → Pages **自动重新部署**（约 1 分钟）。
既不用手动传文件，也不会再出现「每次更新后 `/proxy/*` 404」。

---

## 二、方式二（备选）：Pages 直接上传（不连 GitHub）

适合不想授权 GitHub 的场景；代价是以后每次改代码都要手动重传整个目录。

1. Workers & Pages → Create → **Pages** → **Direct Upload（直接上传）**；
2. 项目名随意 → 把 `vault-app/` **目录内的所有文件**（必须含 `functions/` 文件夹）拖进去 → **Deploy**；
3. Settings → Environment variables 加 `VAULT_API_KEY`（Production）→ **重新部署一次**（环境变量要部署后才生效）；
4. 先在 `https://<项目名>.pages.dev/proxy/entry_list` 验证返回 JSON，再搬域名（步骤同方式一第 6 步）；
5. 缺点：以后每次改代码都要手动重传整个目录（所以只当备选）。

---

## 三、方式三（手动备选）：单个 Worker 粘贴代码（不连仓库时用）

方式一（Workers Builds）是这个方案的自动化版；只有在没法连 GitHub 时，才用手动版——
仓库里已写好现成代码：**`vault-app/worker.js`**。

1. Cloudflare → **Workers and Pages → Create → 创建 Worker（带静态资源/Start from Hello World 均可）**；
2. 上传静态文件：Worker → **Settings → 静态资源/Assets** → 上传 `vault-app/` 里的
   `index.html / styles.css / app.js / api.js / crypto.js / config.js`；
3. **编辑代码**：清空默认代码，粘贴 `worker.js` 全部内容 → **部署**；
4. **Settings → 变量和机密 → 添加**：`VAULT_API_KEY` = `sk-af87...`（类型选**加密**）→ 再次部署；
5. 绑域名：Worker → **Settings → 域和路由/Triggers → Custom Domain** → 输 `wyh.weternal.cc.cd`；
6. 验证：访问 `/proxy/entry_list` 应返回 `{"code":"OK","rows":[...]}`（不再是 NO_KEY/404）。

> 注意：Worker 的 assets 是手动上传的，改代码后要重新上传 assets（或用 wrangler CLI 同步）；
> `worker.js` 里 `/proxy/` 白名单与 `API.md` 的 8 个接口一致。

### ⚠️ Worker 部署的头号坑：每次更新后 `/proxy/*` 全部 404

**现象**：解锁时报「接口 entry_list 返回 HTTP 404（代理未生效？…）」，但首页能正常打开。

**根因**：Worker 的部署 = 脚本（`worker.js`）+ 静态资产，二者是一个整体。
每次通过「上传资产 / Quick Edit 部署」更新时，如果上传的内容里**不含 `worker.js`**，
新部署就会用默认的空脚本——静态文件照常服务（首页正常），但 `/proxy/` 路由没了 → 404。
用 `upload_github.py` 推送更新时同理：脚本默认文件清单里漏掉 `worker.js`，
从仓库拉代码部署就会漏掉代理（2026-10-25 已修复，`worker.js` 已加入默认清单）。

**修复（每次更新后按此操作）**：
1. 上传/部署时确保文件夹里**包含 `worker.js`**（Dashboard 上传如询问入口文件，选 `worker.js`）；
2. 或部署后进 Worker → **编辑代码**，确认代码还是 `worker.js` 的内容（被清空了就重新粘贴部署）；
3. **Settings → 变量和机密**确认 `VAULT_API_KEY` 还在（没有会报 500 `NO_KEY`，不是 404）；
4. 验证：浏览器直接开 `https://wyh.weternal.cc.cd/proxy/entry_list`，
   应返回 JSON（如 `{"code":"OK","rows":[...]}` 或缺参数的业务报错），**不再是 404 网页**即修复。

> 备忘：404 = 路由不存在（脚本问题）；500 `NO_KEY` = 密钥没配；业务 `code` 非 OK = 密钥/接口问题。三种报错对应三种修法。

### ⚠️⚠️ 最终定论（2026-10-25 实测）：Worker 的「上传静态文件」流程救不了代理

如果 Worker 是通过 **「上传静态文件以更新 Worker」**（Upload static files）创建/更新的——
看上传页有黄色警告「**不支持 Pages Functions**」「此上传程序目前仅支持静态资产」——
那么这个 Worker 是 **assets-only**：上传的 `worker.js` 会被当成普通静态文件（可通过
`https://<域名>/worker.js` 下载验证），**从不作为脚本执行**，且该页面没有「编辑代码」入口。
此流程下 `/proxy/*` 永远 404，换多少次文件都没用。

**正解：换成会执行脚本的部署方式**（2026-10-25 已按方式一跑通）：
- **方式一（推荐，已采用）**：「创建 Worker」页面选**「导入现有 Git 存储库」**——实测落地为
  **Pages 项目**（`functions/` 生效，`/proxy/*` 由 Pages Functions 代理），推送即自动部署；
- **方式二**：Pages 直接上传（拖拽流程一样，但 Pages 认 `functions/` 目录）。

共同底线：**全程不要先删还在跑着域名的 Worker**——域名绑定会跟着丢（Error 1016 / NXDOMAIN 就是这么来的）。

---

## 四、部署后验证清单

打开 `https://<项目名>.pages.dev`，逐项确认：

- [ ] 页面正常加载，无白屏；
- [ ] F12 → Console 无红色报错；
- [ ] 设置主密码 → 进入后有分类和「新增条目」按钮；
- [ ] 新增一条密码 → 刷新页面 → 解锁后条目还在（说明写进了 MySQL）；
- [ ] F12 → Network 能看到 `/proxy/entry_list`、`/proxy/cat_list` 请求返回 **200**；
- [ ] 在页面上右键「查看网页源代码」，搜 `sk-` **搜不到**（证明密钥没进前端）；
- [ ] 手机浏览器打开，布局正常（响应式已适配）。

---

## 五、绑定自己的域名（可选）

1. Pages 项目 → **Custom domains** → **Set up a domain**；
2. 输入域名（该域名需已在 Cloudflare 托管，或按提示改 NS）；
3. CF 自动配好 DNS 和 HTTPS 证书，几分钟后生效。
4. 不绑域名的话，`*.pages.dev` 本身就是免费 HTTPS，可直接用。

---

## 六、以后怎么更新

- **方式一（Workers Builds）**：改本地 `vault-app/` 文件 → 跑 `upload_github.py` 推送 →
  Cloudflare **自动重新部署**（约 1 分钟），不用回 Dashboard 操作；
- 也可以 GitHub 网页上直接编辑/覆盖文件，或装了 git 后 `git push`——同样触发自动部署；
- **方式二（Pages 手动上传）**：每次改完要把 `vault-app/` 整个目录重传一次（含 `functions/`）。

---

### 一键上传脚本（推荐，无需 git）

项目根目录（与 `vault-app/` 平级）有 **`upload_github.py`**，一条命令把最新代码推到 GitHub，
Cloudflare 收到推送后**自动重新部署**（约 1 分钟），不需要再回 Cloudflare 页面操作。

```bash
# 进入项目根目录（upload_github.py 所在目录）
cd C:/Users/Administrator/WorkBuddy/2026-10-24-20-26-03

# 上传全部核心文件（index/styles/app/api/crypto/config/worker.js/wrangler.toml + functions/proxy）
C:/Users/Administrator/.workbuddy/binaries/python/envs/default/Scripts/python.exe upload_github.py

# 只传改动过的某个文件（更快）
... upload_github.py app.js api.js

# 演练模式：只列出会传哪些文件，不联网不提交
... upload_github.py --dry-run
```

**首次使用**需要一个 GitHub Personal Access Token（classic）：
GitHub 网页 → 头像 → Settings → Developer settings → Personal access tokens →
Tokens (classic) → Generate new token → **勾选 `repo` 权限** → 复制（`ghp_` 开头）。

**推荐「记事本方式」提供 token**（避开命令行粘贴问题）：用记事本新建文件，
第一行粘贴 token（不要引号、不要多余空格），另存为 `_gh_token.txt`
（保存时「编码」选 UTF-8，且必须放在 `upload_github.py` **同目录**）。
之后每次运行脚本自动读取，无需再输入。也可以直接在脚本提示时粘贴输入（屏幕上会回显）。

> 唯一需要回 Cloudflare 手动操作的情况：**改了环境变量**（如轮换 `VAULT_API_KEY`）——
> 必须 Deployments → 最新部署 ⋯ → Retry deploy，代码推送触发的自动部署不重新读取环境变量。

---

## 注意事项（重要）

1. **apiSQL 接口不要配 IP 白名单**：代理走 Cloudflare 出口 IP（动态、不固定），配了会被拦。
   密钥安全靠「环境变量 + 函数白名单」保障。若坚持要白名单，就只能用直连模式
   （`config.js` 填 `base`+`key`，密钥暴露在前端，且需 apiSQL 放行浏览器 CORS）。
2. **CORS**：直连模式要求 apiSQL 返回跨域响应头；若浏览器 Console 报 CORS 错误，
   说明平台没放行——改用代理模式（同源请求，无此问题）。
3. **免费额度**：Pages Functions 免费版每天 10 万次请求，个人使用远远够。
4. **数据边界**：MySQL 里只有密文，主密码和密钥都不落库；但网址是公开的，
   任何人都能打开试密码。如需再加一层防护，可给 Pages 配 Cloudflare Access（邮箱验证码才能进）。
5. **想回退本地模式**：把 `config.js` 的 `mode` 改回 `"local"` 提交/上传，
   浏览器里原有 localStorage 数据不受影响。
