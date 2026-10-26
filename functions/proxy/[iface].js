/**
 * Cloudflare Pages Function · apiSQL 代理
 * 路径：/proxy/<接口名>   （如 /proxy/entry_list?params[id]=xxx）
 * 作用：浏览器同源请求本函数 → 函数服务端转发到 apiSQL 并注入 Bearer 密钥
 * 密钥来源：Pages 环境变量 VAULT_API_KEY（Dashboard 配置，加密存储，不进仓库/前端）
 * 附带解决：浏览器直连 apiSQL 的 CORS 跨域问题（同源请求无跨域）
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  const iface = String(params.iface || "");

  // 只允许白名单内的接口名，防止被当成开放代理滥用
  const ALLOWED = ["entry_list", "entry_save", "entry_delete", "entry_restore", "entry_purge",
                   "cat_list", "cat_save", "cat_delete",
                   "meta_get", "meta_save"];
  if (!ALLOWED.includes(iface)) {
    return new Response(JSON.stringify({ code: "IFACE_NOT_ALLOWED", message: "接口不在白名单: " + iface }), {
      status: 403, headers: { "Content-Type": "application/json" }
    });
  }
  if (!env.VAULT_API_KEY) {
    return new Response(JSON.stringify({ code: "NO_KEY", message: "未配置环境变量 VAULT_API_KEY" }), {
      status: 500, headers: { "Content-Type": "application/json" }
    });
  }

  // 原样透传查询串（params[名]=值 格式），服务端附加鉴权头
  const target = "https://open.apisql.cn/api/weternal_pwd/" + encodeURIComponent(iface)
               + new URL(request.url).search;
  let resp;
  try {
    resp = await fetch(target, {
      method: "GET",
      headers: { "Authorization": "Bearer " + env.VAULT_API_KEY, "Accept": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ code: "UPSTREAM_ERROR", message: String(e) }), {
      status: 502, headers: { "Content-Type": "application/json" }
    });
  }

  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"   // 敏感数据不进边缘缓存
    }
  });
}
