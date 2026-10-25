/* ============================================================
 * Vault · 数据访问层
 *  两种后端，同一接口：
 *   LocalStore  —— AES-GCM 加密整包存 localStorage（当前默认，含测试数据）
 *   ApisqlStore —— 经 apiSQL SQL 接口读写 MySQL（接口建好后切换）
 *
 *  统一接口：
 *   load() -> {entries:[...], cats:[...]}
 *   saveEntries(entries) / saveCats(cats)
 * ============================================================ */

/* ---------- apiSQL 调用（遵循平台规则：GET + params[k]=v + Bearer） ----------
 * 两种通路：
 *  proxy 模式（推荐，Cloudflare Pages 部署）：同源请求 /proxy/<接口>，
 *    由 Pages Function 服务端附加 Bearer 密钥——密钥只放在 Pages 环境变量，不进前端。
 *  直连模式：浏览器直接打 apiSQL，密钥在前端 cfg.key（有暴露风险，且需平台放行 CORS）。
 * ------------------------------------------------------------ */
async function apiCall(cfg, iface, params = {}) {
  const headers = { "Accept": "application/json" };
  const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  let url;
  if (cfg.proxy) {
    // 同源代理：/proxy/<接口>?params[名]=值（密钥由 Pages Function 服务端附加）
    const p = cfg.proxy.replace(/^\/+|\/+$/g, "");
    url = new URL(location.origin + "/" + (p ? p + "/" : "") + iface);
  } else {
    url = new URL(cfg.base.replace(/\/+$/, "") + "/" + iface);
    headers["Authorization"] = "Bearer " + cfg.key;
  }
  q.forEach(([k, v]) => url.searchParams.set("params[" + k + "]", v));
  const res = await fetch(url, { method: "GET", headers });
  const data = await res.json().catch(() => ({}));
  if (data.code && data.code !== "OK" && data.code !== "SUCCESS") throw new Error(data.message || data.code);
  return data.rows || data.data || [];
}

/* ---------- 本地加密存储（默认后端） ---------- */
const LocalStore = {
  KEY: "vault.data",

  async load(key) {
    const raw = localStorage.getItem(this.KEY);
    if (!raw) return { entries: seedEntries(), cats: seedCats() }; // 首次运行 → 测试数据
    try {
      const box = JSON.parse(raw);
      return await VaultCrypto.decryptObj(key, box);
    } catch (e) {
      throw new Error("数据解密失败：密钥不匹配或数据已损坏");
    }
  },

  async save(key, data) {
    const box = await VaultCrypto.encryptObj(key, data);
    localStorage.setItem(this.KEY, JSON.stringify(box));
  }
};

/* ---------- apiSQL 后端（接口建好后切换 config.mode = "apisql" 即用） ----------
 * MySQL 建表参考：
 *   CREATE TABLE pv_entry (
 *     id VARCHAR(36) PRIMARY KEY, name VARCHAR(128), user VARCHAR(128),
 *     pw TEXT, cat VARCHAR(64), note TEXT, url VARCHAR(256),
 *     fav TINYINT, deleted TINYINT DEFAULT 2, updated_at DATETIME
 *   );
 *   CREATE TABLE pv_cat (name VARCHAR(64) PRIMARY KEY, sort TINYINT DEFAULT 2);
 * 注意：pw / note 等敏感列在写入前已由前端 AES-GCM 加密，库里只见密文；
 *       主密码 verifier / salt 存 pv_meta（自建接口），不存明文。
 *       SQL 接口里避免使用值 0（apiSQL 会视为未提供），TINYINT 列传 1/2。
 *       apiSQL 以「单条预处理语句」执行接口 SQL，多语句会报 500 语法错误。
 *       datetime 列回读为 UTC ISO（如 2026-10-25T07:35:45.000Z），前端需本地化。
 * ---------------------------------------------------------------- */
/* 平台回读的 UTC ISO 时间转回本地 "YYYY-MM-DD HH:MM:SS" */
function toLocalDT(v) {
  if (!v) return "";
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = n => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
         " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function createApisqlStore(cfg) {
  const E = cfg.endpoints, FAV_ON = 1, FAV_OFF = 2, DEL_YES = 1, DEL_NO = 2;
  return {
    async load(key) {
      const rows = await apiCall(cfg, E.list);
      return {
        entries: rows.map(r => ({ ...r, fav: r.fav === FAV_ON, deleted: r.deleted === DEL_YES, updated_at: toLocalDT(r.updated_at) })),
        cats: (await apiCall(cfg, E.cats)).map(r => r.name)
      };
    },
    async save(key, data) {
      for (const e of data.entries) {
        await apiCall(cfg, E.save, {
          id: e.id, name: e.name, user: e.user, pw: e.pw, cat: e.cat,
          note: e.note || " ", url: e.url || " ",
          fav: e.fav ? FAV_ON : FAV_OFF, deleted: e.deleted ? DEL_YES : DEL_NO,
          updated_at: new Date().toISOString().slice(0, 19).replace("T", " ")
        });
      }
      /* 分类同步（cat_save 只能是单语句 upsert，重命名/删除由前端 diff 完成）：
         本地有、线上没有 → cat_save 新增；线上有、本地没有 → cat_delete 清理旧名 */
      const remote = (await apiCall(cfg, E.cats)).map(r => r.name);
      for (const c of data.cats) {
        if (!remote.includes(c)) await apiCall(cfg, E.catSave, { name: c });
      }
      for (const c of remote) {
        if (!data.cats.includes(c)) await apiCall(cfg, E.catDel, { name: c });
      }
    }
  };
}

/* ---------- 测试数据 ---------- */
function seedCats() {
  return ["开发", "金融", "邮箱", "效率", "生活"];
}
function seedEntries() {
  const mk = (name, user, pw, cat, fav, note, url) =>
    ({ id: crypto.randomUUID(), name, user, pw, cat, fav, note, url, deleted: false });
  return [
    mk("GitHub", "octocat@me.com", "T7#kP9qL!mW2", "开发", true, "工作账号，开启 2FA。", "github.com"),
    mk("招商银行", "6225********8831", "Zh@8842#bank", "金融", true, "网银登录，勿存支付密码。", "cmbchina.com"),
    mk("网易邮箱", "myname@163.com", "netease_2024x", "邮箱", false, "", "mail.163.com"),
    mk("Notion", "myname@gmail.com", "N0t!0nP@ss9", "效率", false, "团队空间邀请链接在备注。", "notion.so"),
    mk("AWS 控制台", "admin@company", "Aws#R00t$Key7", "开发", false, "root 账号，限制 IP 登录。", "aws.amazon.com"),
    mk("Steam", "gamer_id_88", "steamg@me2023", "生活", false, "", "store.steampowered.com")
  ];
}

/* ---------- 选择后端 ---------- */
function getStore() {
  const cfg = window.VAULT_CONFIG;
  const a = cfg.apisql || {};
  if (cfg.mode === "apisql" && (a.proxy || (a.base && a.key))) {
    return { store: createApisqlStore(a), mode: "apisql" };
  }
  return { store: LocalStore, mode: "local" };
}
