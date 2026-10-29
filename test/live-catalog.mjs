import assert from "node:assert/strict";
import fs from "node:fs/promises";

export async function verifyDeployment(base, credentials) {
  const origin = new URL(base).origin;
  let cookie = "";
  const call = (path, method = "GET", body, authenticated = false) => fetch(origin + path, {
    method,
    headers: { origin, "Content-Type": "application/json", ...(authenticated ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(45000),
  });
  const home = await call("/");
  assert.equal(home.status, 200);
  const html = await home.text();
  for (const marker of ["keys-dialog", "provider-filter", "logo-symbol.png", "#fffaf5"])
    assert(html.includes(marker), `Missing released UI marker: ${marker}`);
  const catalogResponse = await call("/api/models");
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  const external = catalog.models.filter(m => m.provider === "openrouter");
  assert(external.length > 20, "Live external model directory unavailable");
  assert(external.every(m => m.requiresLogin && !m.available));
  assert(catalog.catalog.updatedAt && ["live", "cached"].includes(catalog.catalog.status));
  assert.equal((await call("/api/keys")).status, 401);
  assert.equal((await call("/api/chat", "POST", {
    model: external[0].id, messages: [{ role: "user", content: "Synthetic access-control probe" }],
  })).status, 403);
  const login = await call("/api/login", "POST", credentials);
  assert.equal(login.status, 200, "Existing account must still sign in");
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/);
  cookie = setCookie.split(";")[0];
  try {
    const keysResponse = await call("/api/keys", "GET", undefined, true);
    assert.equal(keysResponse.status, 200);
    const keys = await keysResponse.json();
    assert.equal(keys.storageAvailable, true, "Encryption secret must be configured");
    for (const key of keys.keys) {
      assert.deepEqual(Object.keys(key).sort(), ["mask", "provider", "updatedAt"]);
      assert(!("ciphertext" in key) && !("key" in key));
    }
    const rejected = await call("/api/keys/verify", "POST", {
      provider: "https://invalid.example", key: "synthetic-invalid-key-never-sent",
    }, true);
    assert.equal(rejected.status, 400);
    return { ui: "released", catalogStatus: catalog.catalog.status, liveModels: external.length,
      publishers: new Set(external.map(m => m.sourceModel.split("/")[0])).size,
      providers: catalog.providers.length, login: "passed", guestDenial: "passed", encryptedStorage: "ready" };
  } finally {
    await call("/api/logout", "POST", {}, true);
  }
}

if (process.argv[1]?.endsWith("live-catalog.mjs")) {
  const credentials = JSON.parse(await fs.readFile(".credentials.json", "utf8"));
  console.log(JSON.stringify(await verifyDeployment(process.argv[2] || "https://llm.veaix.com", credentials), null, 2));
}
