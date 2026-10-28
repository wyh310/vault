/* ============================================================
 * Vault · 面容/Passkey 快速解锁模块（WebAuthn PRF）
 *  - 平台 passkey（Face ID/Touch ID）经 PRF 扩展派生「包裹密钥」
 *  - 包裹密钥 AES-GCM 加密保险库主密钥，密文存 localStorage
 *  - 解锁：Face ID → 派生 → 解包 → 主密钥；主密码路径不受影响（兜底）
 *  - 支持：iOS/iPadOS 18+ Safari、macOS Safari 18+、Chrome/Edge 128+（GPM passkey）
 *    Windows Hello 未开放 PRF → 该平台按钮自动隐藏，继续用主密码
 *  - 数据库/主密码/加密方案零改动；删除包裹数据即完全回退
 * ============================================================ */
const VaultPasskey = (() => {
  const LS = "vault.passkey";
  /* 固定盐：同一 passkey 每次派生结果恒定（PRF 的确定性），换盐会导致旧包裹解不开 */
  const PRF_SALT = new TextEncoder().encode("vault.prf.wrap.v1");

  const b64u = b => { let s = ""; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const ub64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; };

  function isEnabled() { try { return !!localStorage.getItem(LS); } catch (e) { return false; } }
  function disable() { try { localStorage.removeItem(LS); } catch (e) {} }

  /* 能力检测：本浏览器/设备是否有用户验证型平台验证器（Face ID/Touch ID/Windows Hello…） */
  async function available() {
    if (!window.PublicKeyCredential || !(window.crypto && window.crypto.subtle)) return false;
    try { return !!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { return false; }
  }

  /* PRF 派生（解锁/评估）：用已注册的 passkey 派生 32 字节包裹密钥材料 */
  async function prfGet(allowCredId) {
    const opts = {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: "required",                      // 必须真实验证（Face ID/设备密码）
      extensions: { prf: { eval: { first: PRF_SALT } } }
    };
    if (allowCredId) opts.allowCredentials = [{ id: allowCredId, type: "public-key" }];
    const assertion = await navigator.credentials.get({ publicKey: opts });
    const r = assertion.getClientExtensionResults()?.prf?.results?.first;
    if (!r) throw new Error("此设备的 passkey 未返回 PRF 结果（系统或浏览器版本过低）");
    return new Uint8Array(r);
  }

  /* 开启：创建 passkey（注册时即评估 PRF；部分平台需再 get 一次），包裹当前主密钥并存 localStorage */
  async function enable(key) {
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Vault", id: location.hostname },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "vault@" + location.hostname, displayName: "Vault 快速解锁" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: PRF_SALT } } }
    }});
    let out = cred.getClientExtensionResults()?.prf?.results?.first;
    if (!out) out = await prfGet(cred.rawId);            // 创建时未出结果 → 立即评估一次
    const wk = await crypto.subtle.importKey("raw", new Uint8Array(out), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const raw = await VaultCrypto.exportRaw(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wk, raw);
    localStorage.setItem(LS, JSON.stringify({ credId: b64u(cred.rawId), iv: b64u(iv), ct: b64u(ct) }));
    return true;
  }

  /* 面容解锁：Face ID → 派生包裹密钥 → 解包 → 返回主密钥 CryptoKey */
  async function unlock() {
    const box = JSON.parse(localStorage.getItem(LS) || "null");
    if (!box) throw new Error("尚未开启面容解锁");
    const prfOut = await prfGet(ub64u(box.credId));
    const wk = await crypto.subtle.importKey("raw", prfOut, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64u(box.iv) }, wk, ub64u(box.ct));
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }

  /* 主密码变更后：用已存在的 passkey（不新建凭证）重新包裹「新主密钥」。
     需再次 Face ID 验证（userVerification=required）。包裹失败由调用方关闭面容解锁，
     否则旧包裹仍在、Face ID 会解回旧密钥而打不开新数据。 */
  async function rewrap(key) {
    const box = JSON.parse(localStorage.getItem(LS) || "null");
    if (!box) throw new Error("尚未开启面容解锁");
    const prfOut = await prfGet(ub64u(box.credId));
    const wk = await crypto.subtle.importKey("raw", prfOut, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const raw = await VaultCrypto.exportRaw(key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wk, raw);
    localStorage.setItem(LS, JSON.stringify({ credId: box.credId, iv: b64u(iv), ct: b64u(ct) }));
    return true;
  }

  return { available, isEnabled, enable, unlock, rewrap, disable };
})();
