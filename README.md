# Vault · 私人密码保险库（第一版）

本地优先的个人密码管理工具，基于高保真原型实现，可部署到 Cloudflare Pages。

## 功能

- 首次运行设置主密码（≥8 位，遗忘不可恢复）
- 主密码经 PBKDF2-SHA256（310,000 次迭代 + 随机盐）派生密钥，**主密码本身不做任何持久化**
- 条目以 AES-256-GCM 加密后存储，密钥只驻留内存，锁定即清除
- 保险库 / 收藏夹 / 分类管理 / 回收站（软删除可恢复）/ 设置
- 新增、编辑、删除、复制、强密码生成器、闲置 5 分钟自动锁定、加密备份导出
- 当前使用内置测试数据（首次运行自动载入，随后加密持久化在 localStorage）

## 本地预览

直接双击 `index.html`，或（推荐）起一个静态服务：

```bash
npx wrangler pages dev .
# 或
python -m http.server 8080
```

## 部署到 Cloudflare Pages

方式一（面板）：Cloudflare Dashboard → Workers & Pages → Create → Pages → 上传本目录。

方式二（命令行）：

```bash
npx wrangler pages deploy . --project-name my-vault
```

纯静态、无构建步骤。

## 切换到 MySQL（apiSQL）数据源

1. 在 apiSQL 平台连接 MySQL，建表：

```sql
CREATE TABLE pv_entry (
  id VARCHAR(36) PRIMARY KEY, name VARCHAR(128), user VARCHAR(128),
  pw TEXT, cat VARCHAR(64), note TEXT, url VARCHAR(256),
  fav TINYINT, deleted TINYINT DEFAULT 2, updated_at DATETIME
);
CREATE TABLE pv_cat (name VARCHAR(64) PRIMARY KEY, sort TINYINT DEFAULT 1);
```

2. 建立接口：`entry_list / entry_save / entry_delete / cat_list / cat_save / cat_delete`
   （注意平台规则：GET 请求、参数用 `params[名]=值`、TINYINT 列勿传 0——本代码已按 1/2 处理）。
3. 编辑 `config.js`：`mode: "apisql"`，填 `base`；`key` 建议通过部署环境注入而非提交仓库，
   并在 apiSQL 侧为接口配置 IP 白名单（纯前端方案 key 必然出现在浏览器请求头中）。

## 安全说明

| 项目 | 处理方式 |
|------|----------|
| 主密码 | 不存储、不上传；仅用于现场派生密钥 |
| 密钥派生 | PBKDF2-SHA256，310,000 次迭代，随机 16 字节盐 |
| 校验器 | SHA-256(派生密钥)，单向，不可反推主密码 |
| 条目数据 | AES-256-GCM 加密（随机 IV），密文落库 |
| apiSQL 模式 | 账号/密码加密后写入（合并密文存 pw 列，user 列只存占位符），MySQL 中无明文账号密码 |
| 密钥与配置 | 不硬编码；apiSQL key 由部署环境注入 |
