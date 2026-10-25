/* ============================================================
 * Vault · 加密模块（WebCrypto，零依赖）
 *  - 主密码 PBKDF2(SHA-256, 310_000 次, 随机盐) 派生 AES-256 密钥
 *  - 校验器 = SHA-256(派生密钥) —— 数据库里不存主密码本身
 *  - 条目用 AES-256-GCM 加密（随机 IV），密文落库
 *  - 任何密钥/盐都不硬编码：盐首次设置时随机生成
 * ============================================================ */
const VaultCrypto = (() => {
  const te = new TextEncoder();
  const td = new TextDecoder();
  const ITER = 310000;

  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const ub64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");

  async function deriveKey(password, saltU8) {
    const base = await crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: saltU8, iterations: ITER, hash: "SHA-256" },
      base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
    );
  }

  /* 生成随机盐（首次设置主密码时调用，存 localStorage —— 盐不是机密） */
  function newSalt() { return b64(crypto.getRandomValues(new Uint8Array(16))); }

  /* 设置主密码：返回 {salt, verifier}，verifier 用于校验解锁输入 */
  async function setup(password) {
    const salt = newSalt();
    const key = await deriveKey(password, ub64(salt));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const verifier = hex(await crypto.subtle.digest("SHA-256", raw));
    raw.fill(0);
    return { salt, verifier };
  }

  /* 校验主密码：派生后对比 verifier */
  async function verify(password, salt, verifier) {
    const key = await deriveKey(password, ub64(salt));
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const v = hex(await crypto.subtle.digest("SHA-256", raw));
    raw.fill(0);
    return v === verifier ? key : null;
  }

  /* AES-256-GCM 加密对象 → {iv, ct} (base64) */
  async function encryptObj(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)));
    return { iv: b64(iv), ct: b64(ct) };
  }

  async function decryptObj(key, box) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(box.iv) }, key, ub64(box.ct));
    return JSON.parse(td.decode(pt));
  }

  return { setup, verify, encryptObj, decryptObj, newSalt };
})();
