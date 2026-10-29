import { PROVIDERS, discoverModels } from "./providers.mjs";

const encode = new TextEncoder();
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const bytesToBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const base64ToBytes = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const schemas = new WeakMap();

export async function ensureKeyStore(env) {
  if (!env.DB) throw fail("密钥安全存储暂不可用。", 503);
  let pending = schemas.get(env.DB);
  if (!pending) {
    pending = env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS byok_keys (owner TEXT NOT NULL, provider TEXT NOT NULL, ciphertext TEXT NOT NULL, iv TEXT NOT NULL, mask TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY(owner, provider))",
    ).run().catch(() => {
      schemas.delete(env.DB);
      throw fail("密钥安全存储暂不可用，请稍后重试。", 503);
    });
    schemas.set(env.DB, pending);
  }
  await pending;
}

export function storageAvailable(env) {
  const value = env.BYOK_ENCRYPTION_KEY;
  if (typeof value !== "string") return false;
  if (/^[a-f\d]{64}$/i.test(value)) return true;
  try { return base64ToBytes(value).byteLength === 32; } catch { return false; }
}

export function providerInfo(id) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw fail("不支持的模型服务商。请选择列表中的服务商。");
  return provider;
}

export function validateKey(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]{12,4096}$/.test(value.trim()))
    throw fail("请输入有效的 API Key，不能包含空格或换行。");
  return value.trim();
}

async function encryptionKey(env) {
  const value = env.BYOK_ENCRYPTION_KEY;
  if (typeof value !== "string" || !value)
    throw fail("密钥安全存储尚未配置，请联系站点管理员。", 503);
  let raw;
  try {
    raw = /^[a-f\d]{64}$/i.test(value)
      ? Uint8Array.from(value.match(/../g), (n) => parseInt(n, 16))
      : base64ToBytes(value);
  } catch { throw fail("密钥安全存储暂不可用。", 503); }
  if (raw.byteLength !== 32) throw fail("密钥安全存储暂不可用。", 503);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// The authenticated account and provider bind each ciphertext to its intended owner.
// Never derive this key from an account password or an expiring login session.
const associatedData = (owner, provider) => encode.encode(JSON.stringify(["veaix-byok-v1", owner, provider]));
export async function sealKey(env, owner, provider, plaintext) {
  providerInfo(provider);
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: associatedData(owner, provider) },
    key,
    encode.encode(validateKey(plaintext)),
  );
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function openKey(env, owner, provider, record) {
  try {
    const key = await encryptionKey(env);
    const value = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv), additionalData: associatedData(owner, provider) },
      key,
      base64ToBytes(record.ciphertext),
    );
    return new TextDecoder().decode(value);
  } catch {
    throw fail("保存的密钥暂时无法解密，请重新保存该服务商的 API Key。", 503);
  }
}

export async function listKeys(env, owner) {
  await ensureKeyStore(env);
  const rows = await env.DB.prepare(
    "SELECT provider,mask,updated FROM byok_keys WHERE owner=? ORDER BY provider",
  ).bind(owner).all();
  return (rows.results || []).map((r) => ({ provider: r.provider, mask: r.mask, updatedAt: r.updated }));
}

export async function getKey(env, owner, provider) {
  providerInfo(provider);
  await ensureKeyStore(env);
  const record = await env.DB.prepare(
    "SELECT ciphertext,iv,updated FROM byok_keys WHERE owner=? AND provider=?",
  ).bind(owner, provider).first();
  if (!record) throw fail("请先在模型与密钥设置中添加该服务商的 API Key。", 409);
  return { key: await openKey(env, owner, provider, record), updatedAt: record.updated };
}

export async function verifyKey(env, owner, provider, supplied, signal) {
  providerInfo(provider);
  const key = supplied === undefined
    ? (await getKey(env, owner, provider)).key
    : validateKey(supplied);
  const models = await discoverModels(provider, key, signal);
  return { models, verifiedAt: Date.now() };
}

export async function saveKey(env, owner, provider, supplied, signal) {
  providerInfo(provider);
  const plaintext = validateKey(supplied);
  // Fail before transmitting a new key when encryption is not configured.
  const sealed = await sealKey(env, owner, provider, plaintext);
  await ensureKeyStore(env);
  const { models, verifiedAt } = await verifyKey(env, owner, provider, plaintext, signal);
  const mask = "•••• " + plaintext.slice(-4);
  await env.DB.prepare(
    "INSERT INTO byok_keys(owner,provider,ciphertext,iv,mask,updated) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,provider) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,mask=excluded.mask,updated=excluded.updated",
  ).bind(owner, provider, sealed.ciphertext, sealed.iv, mask, verifiedAt).run();
  return { ok: true, key: { provider, mask, updatedAt: verifiedAt }, modelCount: models.length };
}

export async function deleteKey(env, owner, provider) {
  providerInfo(provider);
  await ensureKeyStore(env);
  await env.DB.prepare("DELETE FROM byok_keys WHERE owner=? AND provider=?").bind(owner, provider).run();
  return { ok: true };
}
