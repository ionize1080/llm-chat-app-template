# VEAIX

A Chinese-first private AI workspace at https://llm.veaix.com, built with Cloudflare Workers AI and D1.

## Features

- Streaming chat: GLM 4.7 Flash, Gemma 4, Qwen 3.8 27B and Qwen 3 30B.
- Signed-in paid models: GLM 5.3 Flash, DeepSeek V4.1 Flash, GLM 5.3 and Kimi K2.7 Code. The server validates the session and model allowlist; guest requests cannot invoke paid services.
- Live model discovery from OpenRouter, plus account-authorized official catalogs for OpenAI, Anthropic, Google Gemini, DeepSeek, xAI, Mistral, Groq and Qwen (Singapore). The picker shows searchable model families, connection channels, context lengths, token prices where supplied, access state and refresh time. Catalog entries do not imply available credits or inference permission. Catalogs are cached for five minutes; failed refreshes are marked explicitly. OpenAI/Gemini vision support uses conservative family rules when their directory lacks capability metadata.
- Signed-in BYOK connections persist across logins. Keys are verified with the provider, encrypted using AES-256-GCM with fresh IVs and account/provider-bound associated data, and saved in D1. The UI receives only a masked suffix. Users can verify, replace or delete connections; failed replacement preserves the prior key. Keys never enter browser storage, chat records or exports.
- Native provider streaming for OpenAI Responses, Anthropic Messages, Gemini and OpenAI-compatible APIs, with cancellation, bounded responses and sanitized errors. All BYOK requests require a server-validated login, even for models with zero advertised token prices. Only fixed official provider URLs are accepted.
- Optional signed-in web search through Cloudflare Web Search / Ceramic. Source links accompany answers and saved conversations. Search sends only the latest question, excluding attached document text; it does not transmit the conversation history. Search failures are shown instead of pretending that an answer was researched.
- An accessible custom model picker with keyboard navigation, grouped access levels, vision labels and payment labels. Original vector logo, matching favicon, and shared action geometry for links and buttons.
- FLUX.1 Schnell image generation; Gemma 4 / Qwen 3.8 image understanding.
- Image, text, Markdown, CSV, code and PDF attachments. Files are limited to 10 MB; extracted text is limited to 24,000 characters / 40 PDF pages. Scanned PDFs require page images. Images are resized in the browser.
- One permitted account: `ionize@163.com`. Passwords are salted PBKDF2 hashes stored as Worker secrets. Sessions use random tokens, hashed in D1, with Secure/HttpOnly/SameSite cookies and a 7-day expiry. Login attempts are limited.
- Signed-in conversations are stored in D1; guests use memory only, with no localStorage/sessionStorage chat history. Only theme preference is saved locally.
- Markdown, sanitized HTML, math rendering, stop/retry, copy, export and light/dark modes.
- Original mainland-China system policy and exact keyword patterns retained. Region comes only from Cloudflare request.cf.country; user-controlled overrides were removed. Checks cover full text, attached documents, image prompts and images. CN requests additionally use Workers AI semantic screening; failures deny generation, and CN answers are checked before being returned. This region buffers answers for screening rather than streaming unchecked text.

## Development

Node 22+ is required. This repository uses Wrangler and its pinned lockfile.

```sh
npm ci
npm run cf-typegen
npm test
npm run check
npm run dev
```

`npm run build` bundles the UI and copies pinned local PDF/math assets; no third-party scripts are loaded at runtime. Wrangler runs this build automatically. Generated assets are excluded from Git.

Initialize an empty database only once:

```sh
npx wrangler d1 execute veaix-chat --remote --file schema.sql
```

The production D1 ID is configured in `wrangler.jsonc`. Set `AUTH_SALT` and `AUTH_HASH` through Cloudflare secrets before using login. To reset the password, generate a fresh random salt and derive a 32-byte PBKDF2-SHA256 hash using 100,000 iterations. Encode both the salt text and password as UTF-8; store the hash as lowercase hex. Upload only the salt and hash through a protected JSON file with `wrangler versions upload --secrets-file`, then deploy that version. Never commit a plaintext password, credential file, or Cloudflare token. Delete existing sessions to revoke all prior logins when resetting credentials.

## Deployment

Cloudflare Workers Builds is connected to `ionize1080/llm-chat-app-template`, branch `main`, deploy command `npm run deploy`. This runs the regression suite and `deploy.mjs`, which checks secret names and initializes `BYOK_ENCRYPTION_KEY` once using 32 random bytes uploaded together with the code via Wrangler --secrets-file. A mode-0600 temporary file outside the repository is removed after the attempt. This atomic upload also works when the newest Worker version is an unpublished preview. Later deployments preserve its exact value. This script targets the production Worker only and rejects extra arguments. Run the first deployment serially; do not run concurrent first-time bootstraps. Missing authentication secrets or a failed secret operation stop deployment. Existing Worker secrets are retained. Run tests and packaging checks before pushing.

The additive `byok_keys` table is created lazily through the existing D1 binding, with single-flight initialization and retries after failure. It is also declared in `schema.sql`; a separate D1 administration token is not required. Do not delete or rotate `BYOK_ENCRYPTION_KEY` without decrypting and re-encrypting stored keys: changing it alone makes connections unreadable. The app still permits only its configured account; multi-user registration is outside this release.

BYOK generation uses the user's own provider balance and an independent 500-request daily site cap. It never falls back to platform credentials. It does not consume the site's premium gateway counter, but enabled web search continues to use site credits. Advertised input/output prices are USD per million tokens where a currency is known; other billable features and provider-specific costs may apply. An API subscription/key is separate from a ChatGPT, Claude or Gemini consumer subscription.

The image workspace has a direct URL: `https://llm.veaix.com/?mode=image`. Workspace switches update this parameter, so refreshes retain the selected workspace. A zone-level Single Redirect sends all `img.veaix.com` requests (HTTP/HTTPS, any path) to that URL with status 301, discarding old paths and query parameters. Its declaration is in `cloudflare/img-redirect.json`; it is managed separately from Worker deployment. Zone: `d859388f7b21f5bcb65de5fcc2bbc2c5`; ruleset: `cfecfc6a0398462db6e69e1322306787`; rule: `b00de71288564dff94bb8f1fec192dea`. The previous root-domain redirect is preserved. To undo the domain migration, disable this specific rule; the original image Worker and DNS binding remain available.

Baseline rollback version before this upgrade: `e0748e89-179d-4304-a025-a30e2c63b571`. Code rollback does not roll back D1 data. Restore compatible secrets and schema as necessary.

## Storage and limits

The account's free Workers AI allocation is shared across all its applications: 10,000 Neurons per day, resetting at 00:00 UTC / 08:00 China and Singapore time. Ordinary models, image generation and moderation continue using this allocation, including for signed-in users. Only explicitly selected paid models and web search use the `veaix-chat` AI Gateway with prepaid Unified Billing. Gateway authentication is enabled; request logging and caching are disabled. No subscription upgrade or automatic top-up was enabled. Existing prepaid credits fund advanced calls; exhaustion produces an actionable error.

Atomic D1 counters cap paid generation at 100 calls and search at 200 calls per UTC day across the site. Failed provider attempts may consume a slot. Input remains capped at 60,000 characters; paid completions are capped at 4,096 tokens including reasoning. These request caps reduce exposure but are not a dollar-denominated budget. The prepaid balance is shared with other applications. Ceramic costs $0.25 per 1,000 searches as of 2026-10-29; models are priced separately by tokens. See [Cloudflare search pricing](https://developers.cloudflare.com/web-search/providers/) and [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

For mainland-China requests, the existing keyword and semantic checks run before search and generation. Search uses a conservative official-source allowlist, then screens retrieved titles, URLs and excerpts before model ingestion. Answers are buffered and screened before either answer text or sources are returned. Login and paid models do not bypass this policy. The narrower source pool can produce no results; the UI states this explicitly.

Guest uploads and generated images remain in the current page only. Logged-in text and upload content are included in saved conversations; generated images are private D1 media. History lists the 100 most recently updated conversations. A saved conversation is limited to 1.9 MB; save failures are visible and the current page stays available for export. Image output over 1.9 MB is temporary and must be downloaded. PDF text extraction is performed locally before extracted text is sent to Workers AI.

## Verification

`npm test` covers geographic spoofing, original topics, long/obfuscated content, cross-origin writes, guest history isolation, injected system roles, fail-closed semantic checks, image policy enforcement, request bounds and answer cleanup. `test/live-smoke.mjs URL` is an explicit live integration test requiring a local ignored `.credentials.json`; it exercises login, model calls, image generation and history CRUD using synthetic data. It consumes the existing free allocation.

Design refinement follows [Impeccable](https://github.com/pbakaus/impeccable): a restrained Operate/Read interface, consistent SVG icons, local assets, visible focus and responsive layouts.

`node test/live-search.mjs https://<origin>` additionally verifies paid-model guest denial, all four authenticated premium models and source-bearing web search. It consumes small amounts of prepaid credits and does not save chat history. Run it explicitly only against an authorized origin.
