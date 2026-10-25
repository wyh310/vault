/**
 * Vault · Cloudflare Worker（静态站点 + apiSQL 代理二合一）
 * ============================================================
 * 适用场景：Pages Functions 不可用时，用单个 Worker 同时托管：
 *   1) 静态文件（index.html / app.js / styles.css …）→ env.ASSETS
 *   2) /proxy/<接口名> → 转发 apiSQL，服务端附加 Bearer 密钥
 *      密钥来源：Worker 环境变量 VAULT_API_KEY（Settings → 变量和机密，选加密）
 *
 * 使用方法：Cloudflare → Workers and Pages → vault → 编辑代码 →
 *           全选清空 → 粘贴本文件全部内容 → 部署。
 *           然后在 Settings → 变量和机密 添加 VAULT_API_KEY（加密），再次部署。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* ---------- /proxy/<接口名> → apiSQL ---------- */
    if (url.pathname.startsWith("/proxy/")) {
      const iface = decodeURIComponent(url.pathname.slice("/proxy/".length).replace(/\/+$/, ""));

      // 接口白名单（与 API.md 一致），防止被当成开放代理
      const ALLOWED = ["entry_list", "entry_save", "entry_delete", "entry_restore", "entry_purge",
                       "cat_list", "cat_save", "cat_delete"];
      if (!ALLOWED.includes(iface)) {
        return json({ code: "IFACE_NOT_ALLOWED", message: "接口不在白名单: " + iface }, 403);
      }
      if (!env.VAULT_API_KEY) {
        return json({ code: "NO_KEY", message: "未配置环境变量 VAULT_API_KEY" }, 500);
      }

      const target = "https://open.apisql.cn/api/weternal_pwd/" + encodeURIComponent(iface) + url.search;
      try {
        const resp = await fetch(target, {
          method: "GET",
          headers: { "Authorization": "Bearer " + env.VAULT_API_KEY, "Accept": "application/json" }
        });
        const body = await resp.text();
        return new Response(body, {
          status: resp.status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (e) {
        return json({ code: "UPSTREAM_ERROR", message: String(e) }, 502);
      }
    }

    /* ---------- 其他路径 → 静态资源 ---------- */
    return env.ASSETS.fetch(request);
  }
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
