import { MODELS } from "./shared.mjs";
import { PROVIDERS, discoverModels } from "./providers.mjs";
import { getKey, listKeys, providerInfo, storageAvailable } from "./byok.mjs";

const TTL = 5 * 60 * 1000;
const MAX_STALE = 24 * 60 * 60 * 1000;
let publicCache = null;
let publicPending = null;
let retryAfter = 0;
// Private catalog entries contain no credentials and are partitioned by the account,
// provider and encrypted-key revision. They never enter the public Cache API.
const privateCatalogs = new Map();

export function clearProviderCatalog(owner, provider) {
  for (const [id, record] of privateCatalogs) {
    if (record.owner === owner && record.provider === provider) privateCatalogs.delete(id);
  }
}

async function publicCatalog(force, signal) {
  const now = Date.now();
  if (publicCache && !force && now - publicCache.updatedAt < TTL)
    return { ...publicCache, status: "cached", stale: false };
  if (publicPending) return publicPending;
  if (now < retryAfter && !force)
    return publicCache && now - publicCache.updatedAt < MAX_STALE
      ? { ...publicCache, status: "stale", stale: true, error: "上游目录暂不可用，显示上次同步结果。" }
      : { models: [], updatedAt: null, status: "unavailable", stale: true, error: "模型目录暂不可用，请稍后刷新。" };
  // No user key is ever sent on this public-directory request.
  publicPending = (async () => {
    try {
      const models = await discoverModels("openrouter", undefined, signal);
      publicCache = { models, updatedAt: Date.now() };
      retryAfter = 0;
      return { ...publicCache, status: "live", stale: false };
    } catch {
      retryAfter = Date.now() + 30000;
      return publicCache && Date.now() - publicCache.updatedAt < MAX_STALE
        ? { ...publicCache, status: "stale", stale: true, error: "上游目录暂不可用，显示上次同步结果。" }
        : { models: [], updatedAt: null, status: "unavailable", stale: true, error: "模型目录暂不可用，请稍后刷新。" };
    } finally { publicPending = null; }
  })();
  return publicPending;
}

async function nativeCatalog(env, owner, provider, force, signal) {
  const credential = await getKey(env, owner, provider);
  const id = JSON.stringify([owner, provider, credential.updatedAt]);
  const prior = privateCatalogs.get(id);
  if (!force && prior && Date.now() - prior.updatedAt < TTL) return prior.models;
  const models = await discoverModels(provider, credential.key, signal);
  clearProviderCatalog(owner, provider);
  // The current app has one permitted account; bound memory if that changes later.
  if (privateCatalogs.size >= 50) privateCatalogs.delete(privateCatalogs.keys().next().value);
  privateCatalogs.set(id, { owner, provider, models, updatedAt: Date.now() });
  return models;
}

export const builtinModels = () => MODELS.map((m) => ({
  ...m, provider: "cloudflare", available: true, requiresLogin: !!m.paid,
  sourceModel: m.id, contextLength: null, pricing: null,
}));

export async function getCatalog(env, owner, force = false, signal) {
  let storageError = null;
  const [publicResult, keys] = await Promise.all([
    publicCatalog(force, signal), owner ? listKeys(env, owner).catch(() => {
      storageError = "保存的连接暂不可用，请稍后重试。";
      return [];
    }) : [],
  ]);
  const configured = new Set(keys.map((k) => k.provider));
  const providerErrors = {};
  const native = owner ? await Promise.all(keys.filter((k) => k.provider !== "openrouter").map(async (k) => {
    try { return await nativeCatalog(env, owner, k.provider, force, signal); }
    catch { providerErrors[k.provider] = "连接失败，请验证密钥或稍后刷新。"; return []; }
  })) : [];
  return {
    models: [...builtinModels(), ...publicResult.models, ...native.flat()].map((m) => ({
      ...m, available: m.provider === "cloudflare" || (configured.has(m.provider) && storageAvailable(env)),
    })),
    providers: PROVIDERS.map((p) => ({ ...p, configured: configured.has(p.id), error: providerErrors[p.id] || storageError })),
    storageAvailable: storageAvailable(env) && !storageError,
    catalog: {
      updatedAt: publicResult.updatedAt, status: publicResult.status, stale: publicResult.stale,
      source: "OpenRouter · 服务商官方目录", error: publicResult.error || null,
    },
  };
}

export function parseRemoteModel(id) {
  if (typeof id !== "string" || id.length > 300) return null;
  const split = id.indexOf(":");
  if (split < 1) return null;
  const provider = id.slice(0, split), sourceModel = id.slice(split + 1);
  if (!PROVIDERS.some((p) => p.id === provider) || !sourceModel || /[\x00-\x20\x7f?#]/.test(sourceModel)) return null;
  return { provider, sourceModel };
}

export async function resolveRemoteModel(env, owner, id, signal) {
  const parsed = parseRemoteModel(id);
  if (!parsed) throw Object.assign(new Error("模型不存在，请刷新模型目录。"), { status: 400 });
  providerInfo(parsed.provider);
  const credential = await getKey(env, owner, parsed.provider);
  const models = parsed.provider === "openrouter"
    ? (await publicCatalog(false, signal)).models
    : await nativeCatalog(env, owner, parsed.provider, false, signal);
  const model = models.find((m) => m.id === id);
  if (!model) throw Object.assign(new Error("该模型已下线或当前密钥没有访问权限，请刷新模型目录。"), { status: 400 });
  return { model, key: credential.key };
}
