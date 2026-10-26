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
 *
 * 容错原则：任何异常（网络失败 / HTTP 非 2xx / 非 JSON / 缺 rows）都必须**显式抛错**，
 * 绝不能静默返回空数组——否则会出现「提示保存成功、刷新后数据没了」的假象。
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
  let res;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch (e) {
    throw new Error("网络请求失败（" + iface + "）");
  }
  if (!res.ok) {
    throw new Error("接口 " + iface + " 返回 HTTP " + res.status +
      (cfg.proxy ? "（代理未生效？请确认 Pages 部署包含 functions 目录、环境变量已配置）" : ""));
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") {
    throw new Error("接口 " + iface + " 返回了非 JSON 内容" +
      (cfg.proxy ? "（代理未生效？返回的可能不是 Pages Function 的响应）" : ""));
  }
  if (data.code && data.code !== "OK" && data.code !== "SUCCESS") throw new Error(data.message || data.code);
  const rows = data.rows || data.data;
  if (!Array.isArray(rows)) throw new Error("接口 " + iface + " 响应缺少 rows 字段");
  return rows;
}

/* ---------- 字段级加密（apisql 模式专用） ----------
 * 账号/密码在前端用主密码派生的 AES-256-GCM 密钥加密后才发往接口，
 * 数据库里只见密文：密文整体存 pw 列（TEXT），user 列只存占位符。
 * 密文格式："v1:" + base64url(IV 12B ∥ 密文+认证Tag)
 * 兼容旧数据：pw 列没有 v1: 前缀的行按老明文使用（load 时打 _legacy 标记），
 *             下次保存该条目时自动转为密文——不需要手动迁移。
 * -------------------------------------------------- */
const ENC_PREFIX = "v1:";
function u8B64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlU8(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const b = atob(s), out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function encCreds(key, user, pw) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify({ u: user || "", p: pw || "" }));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv); all.set(new Uint8Array(ct), iv.length);
  return ENC_PREFIX + u8B64url(all);
}
async function decCreds(key, blob) {
  const all = b64urlU8(blob.slice(ENC_PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, key, all.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
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
  },

  /* 单条保存：local 整包存（同步、极快），第二个参数忽略 */
  async saveEntry(key, entry, allData) {
    return this.save(key, allData);
  },

  async syncCats() { /* local 无分类表，整包已含 */ }
};

/* ---------- apiSQL 后端（接口建好后切换 config.mode = "apisql" 即用） ----------
 * MySQL 建表参考：
 *   CREATE TABLE pv_entry (
 *     id VARCHAR(36) PRIMARY KEY, name VARCHAR(128), user VARCHAR(128),
 *     pw TEXT, cat VARCHAR(64), note TEXT, url VARCHAR(256),
 *     fav TINYINT, deleted TINYINT DEFAULT 2, updated_at DATETIME
 *   );
 *   CREATE TABLE pv_cat (name VARCHAR(64) PRIMARY KEY, sort TINYINT DEFAULT 2);
 * 注意：账号/密码由前端 AES-256-GCM 加密后才写入——密文整体存 pw 列（TEXT），
 *       user 列只存占位符，数据库里没有任何明文账号密码；
 *       主密码 verifier / salt 存 localStorage（vault.auth），从不入数据库。
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
      const entries = [];
      let broken = 0;
      for (const r of rows) {
        let user = r.user, pw = r.pw, legacy = false;
        if (typeof r.pw === "string" && r.pw.startsWith(ENC_PREFIX)) {
          try {
            const c = await decCreds(key, r.pw);
            user = c.u; pw = c.p;
          } catch (err) {
            /* 密文与当前密钥不匹配（如换浏览器/重置后遗留的旧密文）：
               跳过该条而不是让整库加载失败，稍后提示用户清理 */
            broken++; continue;
          }
        } else {
          legacy = true;   // 旧版明文数据：先照常展示，由 app 层在解锁后自动转存为密文
        }
        entries.push({ ...r, user, pw, _legacy: legacy,
          fav: r.fav === FAV_ON, deleted: r.deleted === DEL_YES, updated_at: toLocalDT(r.updated_at) });
      }
      if (broken) setTimeout(() => toast(`有 ${broken} 条数据与当前主密码不匹配，已跳过（旧密文无法解密，可在数据库中清理）`), 600);
      return {
        entries,
        cats: (await apiCall(cfg, E.cats)).map(r => r.name)
      };
    },
    async save(key, data) {
      for (const e of data.entries) {
        await apiCall(cfg, E.save, {
          id: e.id, name: e.name, user: " ", pw: await encCreds(key, e.user, e.pw), cat: e.cat,
          note: e.note || " ", url: e.url || " ",
          fav: e.fav ? FAV_ON : FAV_OFF, deleted: e.deleted ? DEL_YES : DEL_NO,
          updated_at: new Date().toISOString().slice(0, 19).replace("T", " ")
        });
      }
      await this.syncCats(data.cats);
    },
    /* 单条保存：只发一次 entry_save（upsert），账号/密码加密为密文后写入 */
    async saveEntry(key, e) {
      await apiCall(cfg, E.save, {
        id: e.id, name: e.name, user: " ", pw: await encCreds(key, e.user, e.pw), cat: e.cat,
        note: e.note || " ", url: e.url || " ",
        fav: e.fav ? FAV_ON : FAV_OFF, deleted: e.deleted ? DEL_YES : DEL_NO,
        updated_at: new Date().toISOString().slice(0, 19).replace("T", " ")
      });
    },
    /* 分类 diff 同步：本地有、线上没有 → cat_save 新增；线上有、本地没有 → cat_delete 清理 */
    async syncCats(cats) {
      const remote = (await apiCall(cfg, E.cats)).map(r => r.name);
      for (const c of cats) {
        if (!remote.includes(c)) await apiCall(cfg, E.catSave, { name: c });
      }
      for (const c of remote) {
        if (!cats.includes(c)) await apiCall(cfg, E.catDel, { name: c });
      }
    },
    /* 物理删除（需平台建 entry_purge 接口；未建则抛错由调用方降级处理） */
    async purgeEntry(key, id) {
      if (!E.purge) throw new Error("未配置 entry_purge 接口");
      await apiCall(cfg, E.purge, { id });
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
