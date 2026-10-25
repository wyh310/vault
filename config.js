// Vault 配置文件
// 原则：密钥与敏感配置不得明文硬编码——
//  - 本地模式无需任何密钥（主密码只存在用户脑中，密钥由它现场派生）。
//  - 切换 apisql 模式时，请把 key 填在部署环境注入的 window.VAULT_CONFIG，
//    或使用 Cloudflare Pages「环境变量 + 构建时注入」，不要提交到仓库。

window.VAULT_CONFIG = {
  // "local"  : 数据加密后存浏览器 localStorage
  // "apisql" : 通过 Cloudflare Pages 代理读写 apiSQL MySQL（密钥在 Pages 环境变量 VAULT_API_KEY）
  mode: "apisql",

  apisql: {
    // 通路二选一：
    //  ① proxy（当前使用，配 Cloudflare Pages）：填 "/proxy"，同源走 Pages Function 代理，
    //     密钥放 Pages 环境变量 VAULT_API_KEY——不进仓库、不进前端、无 CORS 问题。
    //     此时 base/key 留空即可。
    //  ② 直连：填 base + key，浏览器直打 apiSQL。密钥会暴露在前端代码里，
    //     且需 apiSQL 放行浏览器跨域（CORS），仅建议本地/临时使用。
    proxy: "/proxy",       // ← 走 Pages Function 代理
    base: "",            // 例：https://open.apisql.cn/api/weternal_pwd
    key: "",             // Bearer API_KEY —— 建议走 proxy，勿提交仓库
    endpoints: {
      list:   "entry_list",     // GET  返回 rows: [{id,name,user,pw,cat,note,url,fav,deleted,updated_at}]
      save:   "entry_save",     // GET  params: 加密后的字段（upsert）
      delete: "entry_delete",   // GET  params: {id}（软删除 deleted=1）
      restore:"entry_restore",  // GET  params: {id}（恢复 deleted=2）
      purge:  "entry_purge",    // GET  params: {id}（物理删除；平台未建此接口则永久删除仅本地生效）
      cats:   "cat_list",       // GET  返回 rows: [{name}]
      catSave:"cat_save",       // GET  params: {name}（单语句 upsert；重命名由前端 diff：cat_delete 旧名 + cat_save 新名）
      catDel: "cat_delete"      // GET  params: {name}
    }
  }
};
