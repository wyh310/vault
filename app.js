/* ============================================================
 * Vault · 应用逻辑
 * ============================================================ */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let KEY = null;          // 解锁后驻留内存的 AES 密钥
let DB = null;           // {entries, cats}
let MODE = "local";
let currentView = "vault";
/* 每页卡片数：桌面 12（3 列×4 行）；手机端（≤760px）10 */
const pageSize = () => window.innerWidth <= 760 ? 10 : 12;
let curPage = 1;        // 当前页码（保险库/收藏夹/回收站共用）
const savingFav = new Set();  // 正在后台保存收藏状态的条目 id（防连点）
const restoring = new Set();  // 正在恢复的条目 id（防连点）
const purging = new Set();    // 正在永久删除的条目 id（防连点）
let idleTimer = null;
const IDLE_MS = 5 * 60 * 1000; // 闲置 5 分钟自动锁定

/* ---------------- 启动 ---------------- */
async function boot() {
  const { mode } = getStore();
  MODE = mode;
  const tag = $("#storeTag"); if (tag) tag.textContent = mode === "apisql" ? "加密 · apiSQL + MySQL" : "加密 · 本机存储";
  const auth = localStorage.getItem("vault.auth");
  if (auth) { $("#unlockScr").style.display = "grid"; }
  else { $("#setupScr").style.display = "grid"; }
}
$("#suBtn").addEventListener("click", doSetup);
$("#suPw2").addEventListener("keydown", e => { if (e.key === "Enter") doSetup(); });
$("#unlockBtn").addEventListener("click", doUnlock);
$("#master").addEventListener("keydown", e => { if (e.key === "Enter") doUnlock(); });
$("#eye").addEventListener("click", () => {
  const i = $("#master"); i.type = i.type === "password" ? "text" : "password";
});

function suErr(msg) { const e = $("#suErr"); e.textContent = msg; e.classList.add("show"); }

async function doSetup() {
  const p1 = $("#suPw1").value, p2 = $("#suPw2").value;
  $("#suErr").classList.remove("show");
  if (p1.length < 8) return suErr("主密码至少 8 位。");
  if (p1 !== p2) return suErr("两次输入不一致。");
  $("#suBtn").textContent = "正在派生密钥…";
  $("#suBtn").disabled = true;
  try {
    const { salt, verifier } = await VaultCrypto.setup(p1);
    localStorage.setItem("vault.auth", JSON.stringify({ salt, verifier, created: Date.now() }));
    KEY = await VaultCrypto.verify(p1, salt, verifier);
    /* apisql 模式初始化空库（不写演示数据，避免污染 MySQL）；local 模式带测试种子 */
    DB = getStore().mode === "apisql" ? { entries: [], cats: [] } : { entries: seedEntries(), cats: seedCats() };
    await persist();
    enterApp();
  } catch (e) {
    $("#suBtn").textContent = "创建保险库"; $("#suBtn").disabled = false;
    suErr("初始化失败：" + e.message);
  }
}

async function doUnlock() {
  const btn = $("#unlockBtn");
  if (btn.disabled) return;                    // 防重复点击
  const pw = $("#master").value;
  if (!pw) return;
  const auth = JSON.parse(localStorage.getItem("vault.auth"));
  $("#err").classList.remove("show");
  /* 进入 loading：密钥派生（PBKDF2 31 万次迭代）+ 加载数据可能要 1~2 秒 */
  btn.disabled = true; btn.classList.add("loading"); btn.textContent = "解锁中…";
  try {
    KEY = await VaultCrypto.verify(pw, auth.salt, auth.verifier);
    if (!KEY) throw new Error("主密码不正确，请重试。");
    const { store } = getStore();
    DB = await store.load(KEY);
  } catch (e) {
    btn.disabled = false; btn.classList.remove("loading"); btn.textContent = "解 锁";
    KEY = null;
    $("#err").textContent = e.message; $("#err").classList.add("show");
    $("#unlockScr").classList.add("shake");
    setTimeout(() => $("#unlockScr").classList.remove("shake"), 420);
    return;
  }
  // 归一化 cats：兼容子分类版本遗留的对象格式，统一回退为扁平字符串数组
  DB.cats = (DB.cats || [])
    .map(c => typeof c === "string" ? c : (c && c.name) || "")
    .filter(Boolean);
  enterApp();
}

function enterApp() {
  $("#setupScr").style.display = "none";
  $("#unlockScr").classList.add("gone");
  $("#unlockScr").style.display = "grid";
  $("#app").classList.add("in");
  renderView(); resetIdle();
}

function lock() {
  KEY = null; DB = null;
  $("#app").classList.remove("in");
  const u = $("#unlockScr");
  u.classList.remove("gone"); u.style.display = "grid";
  $("#master").value = ""; $("#err").classList.remove("show");
  u.classList.remove("shake");
  /* 重置解锁按钮：上次解锁成功后按钮停留在「解锁中…」禁用态，不重置则锁定后再也无法点击 */
  const b = $("#unlockBtn");
  b.disabled = false; b.classList.remove("loading"); b.textContent = "解 锁";
}
$("#lockNow").addEventListener("click", lock);

function resetIdle() {
  clearTimeout(idleTimer);
  if (KEY) idleTimer = setTimeout(lock, IDLE_MS);
}
["click", "keydown", "mousemove"].forEach(ev =>
  document.addEventListener(ev, () => { if (KEY) resetIdle(); }, { passive: true }));

/* ---------------- 持久化 ---------------- */
async function persist() {
  const { store } = getStore();
  await store.save(KEY, DB);
}
/* ---------- 快路径持久化（避免全量重存导致交互卡顿） ----------
 * apisql：只 upsert 受影响的条目 + 分类 diff（各 1~N 次轻量请求）；
 * local  ：整包加密存（同步、极快），行为与原来一致。
 * ----------------------------------------------------------- */
async function persistEntries(list) {
  const { store, mode } = getStore();
  if (mode === "apisql") {
    for (const e of list) await store.saveEntry(KEY, e);
    await store.syncCats(DB.cats);
  } else {
    await persist();
  }
}
async function persistEntry(e) { return persistEntries([e]); }
/* 仅分类变更（增/删/改）：apisql 只做分类 diff，不动条目 */
async function persistCats() {
  const { store, mode } = getStore();
  if (mode === "apisql") await store.syncCats(DB.cats);
  else await persist();
}

/* ---------------- 导航 ---------------- */
$("#nav").addEventListener("click", e => {
  const b = e.target.closest("button[data-view]"); if (!b) return;
  $$("#nav button").forEach(x => x.classList.remove("active"));
  b.classList.add("active"); currentView = b.dataset.view;
  curPage = 1;
  renderView(); $("#sidebar").classList.remove("open");
});
$("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
$("#sideMask").addEventListener("click", () => $("#sidebar").classList.remove("open"));
$("#sbToggle").addEventListener("click", () => {
  const sb = $("#sidebar");
  if (window.innerWidth <= 760) sb.classList.remove("open");
  else $("#app").classList.toggle("rail");
});
$("#search").addEventListener("input", () => { if (currentView === "vault" || currentView === "fav") { curPage = 1; renderView(); } });
/* 窗口跨越 760px 断点时每页条数在 12/10 间切换，重渲染并 clamp 页码，防越界 */
let _ps = pageSize();
window.addEventListener("resize", () => {
  const ps = pageSize();
  if (ps !== _ps) { _ps = ps; if (["vault", "fav", "trash"].includes(currentView)) renderView(); }
});
$("#addBtn").addEventListener("click", () => openForm(null));

/* ---------------- 分类筛选 ---------------- */
let filterCat = "全部";
/* 分类图标：标签形（线性）；「全部」图标：网格形（线性） */
const I_TAG = `<path d="M20.59 13.41 11 3H4v7l9.59 9.59a2 2 0 0 0 2.82 0l4.18-4.18a2 2 0 0 0 0-2.82Z"/><circle cx="7.5" cy="7.5" r="1.5"/>`;
const I_GRID = `<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>`;
const svgIcon = inner => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">${inner}</svg>`;
const cfIconHTML = () => filterCat === "全部" ? I_GRID : I_TAG;

/* ---------------- 分类（扁平，无子分类） ----------------
 * DB.cats 为字符串数组，如 ["开发","金融","邮箱"]
 */

function refreshCatFilter() {
  if (!DB.cats.includes(filterCat)) filterCat = "全部";
  $("#cfVal").textContent = filterCat;
  $("#cfIcon").innerHTML = cfIconHTML();
  const opts = [`<button type="button" class="cf-opt ${filterCat === "全部" ? "sel" : ""}" data-cf="全部">${svgIcon(I_GRID)}<span>全部</span></button>`];
  DB.cats.forEach(c => {
    opts.push(`<button type="button" class="cf-opt ${filterCat === c ? "sel" : ""}" data-cf="${escAttr(c)}">${svgIcon(I_TAG)}<span>${esc(c)}</span></button>`);
  });
  $("#cfMenu").innerHTML = opts.join("") +
    `<div class="cf-foot"><button type="button" data-cfgo="cats">＋ 添加</button><button type="button" data-cfgo="cats2">⚙ 管理</button></div>`;
}
function syncCatFilterVis() {
  const show = currentView === "vault" || currentView === "fav";
  $("#catFilter").style.display = show ? "" : "none";
}
$("#cfBtn").addEventListener("click", e => {
  e.stopPropagation();
  $("#catFilter").classList.toggle("open");
});
$("#cfMenu").addEventListener("click", e => {
  e.stopPropagation();
  const opt = e.target.closest("[data-cf]"), go = e.target.closest("[data-cfgo]");
  if (opt) {
    filterCat = opt.dataset.cf;
    curPage = 1;
    $("#cfVal").textContent = filterCat;
    $("#cfIcon").innerHTML = cfIconHTML();
    $("#catFilter").classList.remove("open");
    renderView();
  }
  if (go) {
    filterCat = "全部";
    $("#catFilter").classList.remove("open");
    $$("#nav button").forEach(x => x.classList.remove("active"));
    $(`#nav button[data-view="cats"]`).classList.add("active");
    currentView = "cats"; renderView();
  }
});
document.addEventListener("click", e => {
  if (!e.target.closest("#catFilter")) $("#catFilter").classList.remove("open");
});

/* ---------------- 渲染 ---------------- */
const favAvatar = n => `<div class="fav">${n.slice(0, 1)}</div>`;
const mask = pw => "•".repeat(Math.min(pw.length, 12));
const cardMask = pw => "•".repeat(Math.min(pw.length, 8));

function counts() {
  $("#cVault").textContent = DB.entries.filter(e => !e.deleted).length;
  $("#cFav").textContent = DB.entries.filter(e => !e.deleted && e.fav).length;
  $("#cTrash").textContent = DB.entries.filter(e => e.deleted).length;
}
function renderView() {
  counts();
  if (currentView !== "vault" && currentView !== "fav") $("#catFilter").classList.remove("open");
  if (currentView === "vault") renderList(DB.entries.filter(e => !e.deleted), "保险库", "所有密码以 AES-256-GCM 加密存储。点击任意条目查看详情。");
  else if (currentView === "fav") renderList(DB.entries.filter(e => !e.deleted && e.fav), "收藏夹", "置顶你最常用的账号，随手就能拿到。");
  else if (currentView === "cats") renderCats();
  else if (currentView === "trash") renderTrash();
  else renderSettings();
}
/* ---------------- 分页 ---------------- */
/* 页码序列：总页数 ≤7 全显示；否则只显示首、尾、当前页及相邻页，中间 … 省略 */
function pageNumbers(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const set = new Set([1, total, cur, cur - 1, cur + 1]);
  const out = [...set].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
  const res = [];
  out.forEach((n, i) => { if (i && n - out[i - 1] > 1) res.push("…"); res.push(n); });
  return res;
}
function pagerHTML(total) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize()));
  if (totalPages <= 1) return "";
  const nums = pageNumbers(curPage, totalPages).map(n =>
    n === "…" ? `<span class="pg-dots">…</span>`
      : `<button type="button" class="pg-num${n === curPage ? " on" : ""}" data-pg="${n}">${n}</button>`).join("");
  return `<div class="pager">
    <button type="button" class="pg-btn" data-pg="${curPage - 1}" ${curPage === 1 ? "disabled" : ""}>${I.chevL}<span>上一页</span></button>
    <div class="pg-nums">${nums}</div>
    <button type="button" class="pg-btn" data-pg="${curPage + 1}" ${curPage === totalPages ? "disabled" : ""}><span>下一页</span>${I.chevR}</button>
  </div>
  <div class="pg-info">第 ${curPage} / ${totalPages} 页 · 共 ${total} 条</div>`;
}
function bindPager() {
  $$("[data-pg]").forEach(b => b.addEventListener("click", () => {
    const n = +b.dataset.pg;
    if (!n || n < 1 || n === curPage) return;
    curPage = n; renderView();
    requestAnimationFrame(() => { const g = $(".grid"); if (g) g.scrollIntoView({ behavior: "smooth", block: "start" }); });
  }));
}
function renderList(list, title, sub) {
  const q = $("#search").value.trim().toLowerCase();
  if (q) list = list.filter(e => (e.name + e.user + e.cat).toLowerCase().includes(q));
  if (filterCat !== "全部") list = list.filter(e => e.cat === filterCat);
  list = [...list].sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0));
  refreshCatFilter(); syncCatFilterVis();
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize()));
  if (curPage > totalPages) curPage = totalPages;
  const page = list.slice((curPage - 1) * pageSize(), curPage * pageSize());
  $("#content").innerHTML = `
    ${page.length ? `<div class="grid">${page.map(cardHTML).join("")}</div>${pagerHTML(total)}`
      : emptyHTML("这里还没有内容", q ? "换个关键词试试。" : "点击右上角「新增条目」添加第一条密码。")}`;
  bindCards(); bindPager();
}
/* 卡片名称/网站行尾的内联元信息：分类小标签 + 备注
 * 替代原卡片底部独立 meta 行——内容挪到名称和网站后面，卡片更矮 */
function cardMetaLine(e) {
  const tag = e.cat ? `<span class="itag" title="${escAttr(e.cat)}">${esc(e.cat)}</span>` : "";
  const note = e.note ? `<span class="mn2" title="${escAttr(e.note)}">${esc(e.note)}</span>` : "";
  if (!e.url && !tag && !note) return "";
  const url = e.url ? `<span class="usr" data-cb="${escAttr(e.url)}" data-tip="已复制网址" title="点击复制">${esc(e.url)}</span>` : "";
  return `<div class="sub2">${url}${tag}${note}</div>`;
}
function cardHTML(e) {
  return `<div class="card" data-id="${e.id}">
    <div class="top">
      <div class="ti"><div class="nm">${esc(e.name)}</div>${cardMetaLine(e)}</div>
      <button class="star ${e.fav ? "on" : ""}" data-star="${e.id}">${e.fav ? "★" : "☆"}</button></div>
    <div class="crow"><span class="cl">账号</span><span class="cv ${e.user ? "" : "ph"}">${e.user ? esc(e.user) : "未设置账号"}</span>${e.user ? `
      <button class="icbtn" data-cb="${escAttr(e.user)}" data-tip="已复制账号" title="复制账号">${I.copy}</button>` : ""}</div>
    <div class="crow"><span class="cl">密码</span><span class="cv mono" id="cpw-${e.id}">${cardMask(e.pw)}</span>
      <button class="icbtn" data-eye="${e.id}" title="显示/隐藏">${I.eye}</button>
      <button class="icbtn" data-cb="${escAttr(e.pw)}" data-tip="已复制密码" title="复制密码">${I.copy}</button></div></div>`;
}
function bindCards() {
  $$(".card").forEach(c => c.addEventListener("click", ev => {
    if (ev.target.closest("[data-star]") || ev.target.closest(".icbtn") || ev.target.closest(".usr")) return;
    openDetail(c.dataset.id);
  }));
  $$("[data-star]").forEach(b => b.addEventListener("click", async () => {
    const e = DB.entries.find(x => x.id === b.dataset.star);
    if (!e || savingFav.has(e.id)) return;          // 防连点（同一条目保存中再点无效）
    savingFav.add(e.id);
    const old = e.fav;
    e.fav = !e.fav; renderView(); toast(e.fav ? "已加入收藏夹" : "已取消收藏");  // UI 立即响应
    try {
      /* 只持久化这一条（apisql 单次 upsert；local 整包存但同步极快） */
      await getStore().store.saveEntry(KEY, e, DB);
    } catch (err) {
      e.fav = old; renderView();                     // 失败回滚
      toast("收藏保存失败：" + (err.message || "网络错误"));
    } finally {
      savingFav.delete(e.id);
    }
  }));
  bindEntryBtns();
}
/* 卡片内复制/显示密码按钮（保险库与回收站卡片共用） */
function bindEntryBtns() {
  $$("[data-eye]").forEach(b => b.addEventListener("click", ev => {
    ev.stopPropagation();
    const e = DB.entries.find(x => x.id === b.dataset.eye);
    const el = $("#cpw-" + e.id);
    const shown = !el.textContent.includes("•");
    el.textContent = shown ? cardMask(e.pw) : e.pw;
    b.innerHTML = shown ? I.eye : I.eyeOff;
    b.classList.toggle("on", !shown);
  }));
  $$("[data-cb]").forEach(b => b.addEventListener("click", ev => {
    ev.stopPropagation();
    /* catch：无头环境/非 HTTPS 下剪贴板可能被拒，避免未捕获的 Promise 拒绝 */
    navigator.clipboard?.writeText(b.dataset.cb).catch(() => {});
    toast(b.dataset.tip || "已复制到剪贴板");
  }));
}
/* 回收站卡片：布局与保险库一致，右上角为「恢复」+「永久删除」 */
function trashCardHTML(e) {
  return `<div class="card trash-card" data-id="${e.id}">
    <div class="top">
      <div class="ti"><div class="nm">${esc(e.name)}</div>${cardMetaLine(e)}</div>
      <div class="ops">
        <button class="star restore" data-restore="${e.id}" title="恢复到保险库">${I.restore}</button>
        <button class="icbtn purge" data-purge="${e.id}" title="永久删除">${I.trash}</button>
      </div>
    </div>
    <div class="crow"><span class="cl">账号</span><span class="cv ${e.user ? "" : "ph"}">${e.user ? esc(e.user) : "未设置账号"}</span>${e.user ? `
      <button class="icbtn" data-cb="${escAttr(e.user)}" data-tip="已复制账号" title="复制账号">${I.copy}</button>` : ""}</div>
    <div class="crow"><span class="cl">密码</span><span class="cv mono" id="cpw-${e.id}">${cardMask(e.pw)}</span>
      <button class="icbtn" data-eye="${e.id}" title="显示/隐藏">${I.eye}</button>
      <button class="icbtn" data-cb="${escAttr(e.pw)}" data-tip="已复制密码" title="复制密码">${I.copy}</button></div></div>`;
}
function renderTrash() {
  const list = DB.entries.filter(e => e.deleted);
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize()));
  if (curPage > totalPages) curPage = totalPages;
  const page = list.slice((curPage - 1) * pageSize(), curPage * pageSize());
  $("#content").innerHTML = `
    <div class="view-head"><h1>回收站</h1><span class="sub">${total} 条</span></div>
    <p class="view-sub">删除的条目会先进入这里，可随时恢复。</p>
    ${page.length ? `<div class="grid">${page.map(trashCardHTML).join("")}</div>${pagerHTML(total)}`
      : emptyHTML("回收站是空的", "删除的密码会暂时保存在此。")}`;
  bindEntryBtns(); bindPager();
  $$("[data-restore]").forEach(b => b.addEventListener("click", async () => {
    const e = DB.entries.find(x => x.id === b.dataset.restore);
    if (!e || restoring.has(e.id)) return;
    restoring.add(e.id);
    e.deleted = false;
    try { await persistEntry(e); renderView(); toast("已恢复"); }
    catch (err) { e.deleted = true; renderView(); toast("恢复失败：" + (err.message || "网络错误")); }
    finally { restoring.delete(e.id); }
  }));
  $$("[data-purge]").forEach(b => b.addEventListener("click", async () => {
    const id = b.dataset.purge;
    const e = DB.entries.find(x => x.id === id);
    if (!e || purging.has(id)) return;
    purging.add(id);
    DB.entries = DB.entries.filter(x => x.id !== id);
    try {
      /* apisql：尽量物理删除线上行（需 entry_purge 接口）；local：整包已存 */
      const { store, mode } = getStore();
      if (mode === "apisql" && store.purgeEntry) {
        try { await store.purgeEntry(KEY, id); }
        catch (perr) { toast("本地已删除；线上清理失败（需在平台建 entry_purge 接口）"); }
      } else await persist();
      renderView(); toast("已永久删除");
    } catch (err) {
      DB.entries.push(e); renderView(); toast("删除失败：" + (err.message || "网络错误"));
    } finally { purging.delete(id); }
  }));
}

/* ---------------- 分类管理（扁平，无子分类） ---------------- */
function renderCats() {
  const rows = DB.cats.map(c => {
    const n = DB.entries.filter(e => !e.deleted && e.cat === c).length;
    return `<div class="cat-item" data-cat="${escAttr(c)}">
        <span class="cn">${esc(c)}</span><span class="cc">${n} 个条目</span>
        <div class="ops">
          <button title="重命名" data-ren="${escAttr(c)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg></button>
          <button title="删除" data-del="${escAttr(c)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></button>
        </div></div>`;
  });
  $("#content").innerHTML = `
    <div class="view-head"><h1>分类管理</h1><span class="sub">${DB.cats.length} 个分类</span></div>
    <p class="view-sub">新增分类、重命名或删除。仅允许删除空分类，避免条目丢失归属。</p>
    <div class="cat-add">
      <input id="newCat" placeholder="输入新分类名称，如「社交」" />
      <button id="addCat">＋ 添加分类</button></div>
    <div class="cat-list">${rows.join("") || `<div class="cc" style="color:var(--faint)">还没有分类</div>`}</div>`;
  $("#addCat").addEventListener("click", () => addCat());
  $("#newCat").addEventListener("keydown", e => { if (e.key === "Enter") addCat(); });
  $$("[data-ren]").forEach(b => b.addEventListener("click", () => startRename(b.dataset.ren)));
  $$("[data-del]").forEach(b => b.addEventListener("click", async () => {
    const c = b.dataset.del;
    if (DB.entries.some(e => !e.deleted && e.cat === c)) return toast("该分类下仍有条目，无法删除");
    DB.cats = DB.cats.filter(x => x !== c); await persistCats(); renderView(); toast("已删除分类");
  }));
}
async function addCat() {
  const v = ($("#newCat")?.value || "").trim();
  if (!v) return;
  if (DB.cats.includes(v)) return toast("分类已存在");
  DB.cats.push(v);
  await persistCats(); renderView(); toast("已添加分类");
}
async function startRename(c) {
  const item = $(`.cat-item[data-cat="${CSS.escape(c)}"]`);
  item.innerHTML = `
    <input value="${esc(c)}" id="renInput" />
    <span class="cc">回车确认，Esc 取消</span>
    <div class="ops"><button id="renOk">确定</button></div>`;
  const input = $("#renInput"); input.focus(); input.select();
  const done = async ok => {
    const v = input.value.trim();
    if (ok && v && v !== c) {
      const i = DB.cats.indexOf(c);
      if (i >= 0) DB.cats[i] = v;
      const affected = DB.entries.filter(e => e.cat === c);
      affected.forEach(e => { e.cat = v; });
      /* 只重存受影响的条目 + 分类 diff（cat_save 新名 + cat_delete 旧名） */
      await persistEntries(affected); toast("已重命名");
    }
    renderView();
  };
  $("#renOk").addEventListener("click", () => done(true));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") done(true);
    if (e.key === "Escape") done(false);
  });
}

/* ---------------- 设置 ---------------- */
function renderSettings() {
  $("#content").innerHTML = `
    <div class="view-head"><h1>设置</h1></div>
    <p class="view-sub">密钥管理、自动锁定与数据备份。</p>
    <div class="set-list">
      <div class="set"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></div>
        <div class="st"><b>自动锁定</b><small>闲置 5 分钟后自动锁定并清除内存密钥</small></div></div>
      <div class="set"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6l-8-4Z"/></svg></div>
        <div class="st"><b>加密方案</b><small>PBKDF2-SHA256 · 310,000 次迭代 → AES-256-GCM（密钥仅存内存）</small></div></div>
      <div class="set"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg></div>
        <div class="st"><b>数据存储</b><small>${MODE === "apisql" ? "apiSQL 接口 → MySQL（敏感列已加密）" : "浏览器 localStorage（AES-GCM 整包加密）"}</small></div></div>
      <div class="set"><div class="si"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v12M12 15l-4-4M12 15l4-4M4 21h16"/></svg></div>
        <div class="st"><b>导出备份</b><small>下载加密数据包（仍需主密码才能解密）</small></div>
        <button class="b-ghost" style="flex:none;padding:9px 16px;height:auto" id="exportBtn">导出</button></div>
    </div>
    <div class="about" style="margin-top:24px">
      <p><b style="color:var(--text)">关于 Vault</b><br/>
      本地优先的私人密码管理器。主密码经 <code>PBKDF2</code> 派生密钥，条目以 <code>AES-256-GCM</code> 加密后存储，
      主密码本身不做任何形式的持久化。当前运行模式：<code>${MODE}</code>。</p>
    </div>`;
  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([localStorage.getItem("vault.data") || "{}"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "vault-backup.json"; a.click();
    toast("已导出加密备份");
  });
}

/* ---------------- 弹窗 ---------------- */
function showModal() { $("#scrim").classList.add("show"); $("#modal").classList.add("show"); }
function closeModal() { $("#scrim").classList.remove("show"); $("#modal").classList.remove("show"); }
$("#scrim").addEventListener("click", closeModal);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

/* 详情弹窗底部：默认态（编辑/删除）与删除确认态（取消/确认删除） */
function detailFootHTML(confirming) {
  return confirming
    ? `<div class="del-tip">删除后可在回收站恢复</div>
       <div class="del-btns">
         <button class="b-ghost" id="delCancel">取消</button>
         <button class="b-danger solid" id="delOk">确认删除</button>
       </div>`
    : `<button class="b-edit" id="editBtn">编辑</button>
       <button class="b-danger" id="delBtn">删除</button>`;
}
function bindDetailFoot(e) {
  const foot = $("#mfoot");
  const doDelete = async () => {
    const ok = $("#delOk"); if (!ok || ok.disabled) return;
    ok.disabled = true; ok.classList.add("loading"); ok.textContent = "删除中…";
    const oldFav = e.fav;
    e.deleted = true; e.fav = false;
    try {
      await persistEntry(e);
      closeModal(); renderView(); toast("已移入回收站");
    } catch (err) {
      e.deleted = false; e.fav = oldFav;   // 失败回滚
      ok.disabled = false; ok.classList.remove("loading"); ok.textContent = "确认删除";
      toast("删除失败：" + (err.message || "网络错误"));
    }
  };
  $("#delBtn")?.addEventListener("click", () => {
    foot.classList.add("confirming");
    foot.innerHTML = detailFootHTML(true);
    bindDetailFoot(e);
  });
  $("#delCancel")?.addEventListener("click", () => {
    foot.classList.remove("confirming");
    foot.innerHTML = detailFootHTML(false);
    bindDetailFoot(e);
  });
  $("#delOk")?.addEventListener("click", doDelete);
  $("#editBtn")?.addEventListener("click", () => openForm(e));
}
function openDetail(id) {
  const e = DB.entries.find(x => x.id === id); if (!e) return;
  $("#modal").innerHTML = `
    <div class="mh dark">${favAvatar(e.name)}<div><div class="t">${esc(e.name)}</div></div>
      <button class="x" onclick="closeModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:18px;height:18px"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="mb">
      <div class="row"><span class="rl">账号</span><span class="chip ${e.user ? "" : "ph"}">${e.user ? esc(e.user) : "未设置账号"}</span>${e.user ? `<button class="icbtn" data-copy="${escAttr(e.user)}" data-tip="已复制账号">${I.copy}</button>` : ""}</div>
      <div class="row"><span class="rl">密码</span><span class="chip mono" id="dpw">${mask(e.pw)}</span>
        <button class="icbtn" id="reveal">${I.eye}</button>
        <button class="icbtn" data-copy="${escAttr(e.pw)}" data-tip="已复制密码">${I.copy}</button></div>
      ${e.url ? `<div class="row"><span class="rl">网址</span><span class="chip">${esc(e.url)}</span>
        <button class="icbtn" data-copy="${escAttr(e.url)}" data-tip="已复制网址">${I.copy}</button></div>` : ""}
      <div class="row"><span class="rl">分类</span><span class="chip cat">${esc(e.cat)}</span></div>
      ${e.note ? `<div class="row top"><span class="rl">备注</span><span class="note">${esc(e.note)}</span></div>` : ""}
    </div>
    <div class="mfoot" id="mfoot">${detailFootHTML(false)}</div>`;
  showModal();
  $("#reveal").addEventListener("click", () => {
    const el = $("#dpw"), btn = $("#reveal");
    const shown = !el.textContent.includes("•");
    el.textContent = shown ? mask(e.pw) : e.pw;
    btn.innerHTML = shown ? I.eye : I.eyeOff;
    btn.classList.toggle("on", !shown);
  });
  bindDetailFoot(e);
  bindCopy();
}

function openForm(e) {
  const isEdit = !!e;
  $("#modal").innerHTML = `
    <div class="mh dark"><div class="fav">＋</div>
      <div><div class="t">${isEdit ? "编辑条目" : "新增条目"}</div><div class="u">填写网站与登录信息</div></div>
      <button class="x" onclick="closeModal()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:18px;height:18px"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    <div class="mb">
      <div class="fld"><label>名称 *</label><input id="fName" value="${isEdit ? escAttr(e.name) : ""}" placeholder="如 GitHub" /></div>
      <div class="fld"><label>用户名 / 账号</label><input id="fUser" value="${isEdit ? escAttr(e.user) : ""}" placeholder="邮箱或用户名" /></div>
      <div class="fld pw-wrap"><label>密码 *</label><input id="fPw" value="${isEdit ? escAttr(e.pw) : ""}" />
        <button class="gen" id="genBtn" title="生成强密码">${I.spark}</button></div>
      <div class="fld"><label>网址（选填）</label><input id="fUrl" value="${isEdit ? escAttr(e.url || "") : ""}" placeholder="https://" /></div>
      <div class="fld"><label>分类</label>${dd("cat", DB.cats, isEdit ? e.cat : (DB.cats[0] || ""))}</div>
      <div class="fld"><label>备注（选填）</label><textarea id="fNote" placeholder="安全提示、2FA 备份码…">${isEdit ? esc(e.note || "") : ""}</textarea></div>
      <div class="toggle-row"><span>加入收藏夹</span><div class="switch ${isEdit && e.fav ? "on" : ""}" id="fFav"><i></i></div></div>
    </div>
    <div class="mfoot"><button class="b-ghost" onclick="closeModal()">取消</button>
      <button class="b-edit" id="saveBtn">保存</button></div>`;
  showModal();
  $("#fFav").addEventListener("click", () => $("#fFav").classList.toggle("on"));
  $("#genBtn").addEventListener("click", () => {
    const s = "!@#$%^&*abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const arr = crypto.getRandomValues(new Uint8Array(16));
    $("#fPw").value = [...arr].map(n => s[n % s.length]).join("");
  });
  $("#saveBtn").addEventListener("click", async () => {
    const btn = $("#saveBtn");
    if (btn.disabled) return;               // 正在保存中，防重复点击
    const name = $("#fName").value.trim(), pw = $("#fPw").value;
    if (!name || !pw) return toast("名称和密码不能为空");
    const cat = $("#modal .dd .dd-val").textContent;
    const fields = {
      name, user: $("#fUser").value.trim(), pw, cat, url: $("#fUrl").value.trim(),
      note: $("#fNote").value.trim(), fav: $("#fFav").classList.contains("on")
    };
    /* 先改内存，保存失败时回滚，避免内存与线上不一致 */
    const old = isEdit ? { name: e.name, user: e.user, pw: e.pw, cat: e.cat, url: e.url, note: e.note, fav: e.fav } : null;
    let newEntry = null;
    if (isEdit) Object.assign(e, fields);
    else { newEntry = { id: crypto.randomUUID(), deleted: false, ...fields }; DB.entries.unshift(newEntry); }
    /* 进入 loading：禁用按钮 + 转圈 + 文案 */
    btn.disabled = true; btn.classList.add("loading"); btn.textContent = "保存中…";
    try {
      await persistEntry(isEdit ? e : newEntry);
      closeModal(); renderView(); toast("已加密保存");
    } catch (err) {
      if (newEntry) DB.entries = DB.entries.filter(x => x !== newEntry);
      else if (old) Object.assign(e, old);
      btn.disabled = false; btn.classList.remove("loading"); btn.textContent = "保存";
      toast("保存失败：" + (err.message || "网络错误") + "，请重试");
    }
  });
}

/* ---------------- 下拉框组件 ---------------- */
const CHEV = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>`;
const CK = `<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 5 5L20 7"/></svg>`;
function dd(id, options, selected) {
  const opts = options.map(o => typeof o === "string" ? { label: o, value: o } : o);
  const sel = opts.find(o => o.value === selected) || opts[0] || { label: "", value: "" };
  const addRow = id === "cat" ? `<div class="dd-new"><input type="text" placeholder="输入新分类名称…" maxlength="12" /><button type="button" class="dd-newbtn" data-newcat="1">添加</button></div>` : "";
  return `<div class="dd" data-dd="${id}">
    <button type="button" class="dd-trigger"><span class="dd-val">${esc(sel.label)}</span>${CHEV}</button>
    <div class="dd-menu">${addRow}${opts.map(o =>
      `<button type="button" class="dd-opt ${o.value === selected ? "sel" : ""}" data-val="${escAttr(o.value)}"><span>${esc(o.label)}</span>${CK}</button>`).join("")}
    </div></div>`;
}
document.addEventListener("click", e => {
  const trig = e.target.closest(".dd-trigger"), opt = e.target.closest(".dd-opt");
  if (trig) {
    const box = trig.parentElement, open = box.classList.contains("open");
    $$(".dd.open").forEach(d => d.classList.remove("open"));
    if (!open) box.classList.add("open");
    return;
  }
  const newBtn = e.target.closest("[data-newcat]");
  if (newBtn) {
    const box = newBtn.closest(".dd");
    const input = box.querySelector(".dd-new input");
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    if (DB.cats.includes(name)) { toast("分类已存在"); return; }
    DB.cats.push(name); persistCats();
    box.outerHTML = dd(box.dataset.dd, DB.cats, name);
    toast("分类已添加"); return;
  }
  if (opt) {
    const box = opt.closest(".dd");
    box.querySelector(".dd-val").textContent = opt.dataset.val;
    box.querySelectorAll(".dd-opt").forEach(o => o.classList.toggle("sel", o === opt));
    box.classList.remove("open"); return;
  }
  if (e.target.closest(".dd")) return; /* 点击下拉内部（如输入框）不关闭 */
  $$(".dd.open").forEach(d => d.classList.remove("open"));
});
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || !e.target.matches(".dd-new input")) return;
  e.preventDefault();
  e.target.parentElement.querySelector("[data-newcat]").click();
});

/* ---------------- 工具 ---------------- */
const I = {
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  eyeOff: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/><path d="m3.5 3.5 17 17"/></svg>`,
  restore: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>`,
  user: `<svg class="vic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5"/></svg>`,
  lock: `<svg class="vic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>`,
  link: `<svg class="vic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1"/></svg>`,
  tag: `<svg class="vic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 11V4a1 1 0 0 1 1-1h7l10 10-8 8L3 11Z"/><circle cx="8" cy="8" r="1.4"/></svg>`,
  chevL: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 6-6 6 6 6"/></svg>`,
  chevR: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 6 6 6-6 6"/></svg>`
};
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
const escAttr = esc;
function emptyHTML(t, s) {
  return `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg><h3>${t}</h3><p>${s}</p></div>`;
}
function bindCopy() {
  $$("[data-copy]").forEach(b => b.addEventListener("click", () => {
    navigator.clipboard?.writeText(b.dataset.copy); toast(b.dataset.tip || "已复制到剪贴板");
  }));
}
let toastT;
function toast(msg) {
  $("#toastMsg").textContent = msg; $("#toast").classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => $("#toast").classList.remove("show"), 1800);
}

boot();
