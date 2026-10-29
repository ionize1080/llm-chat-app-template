# VEAIX

A Chinese-first private AI workspace at https://llm.veaix.com, built with Cloudflare Workers AI and D1.

## Features

- Streaming chat: GLM 4.7 Flash, Gemma 4, Qwen 3.8 27B and Qwen 3 30B.
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

Cloudflare Workers Builds is connected to `ionize1080/llm-chat-app-template`, branch `main`, deploy command `npm run deploy`. Deployments retain existing Worker secrets. Run tests and packaging checks before pushing. Manual deployment uses `npm run deploy`.

Baseline rollback version before this upgrade: `e0748e89-179d-4304-a025-a30e2c63b571`. Code rollback does not roll back D1 data. Restore compatible secrets and schema as necessary.

## Storage and limits

The account's free Workers AI allocation is shared across all its applications: 10,000 Neurons per day, resetting at 00:00 UTC / 08:00 China and Singapore time. No paid model, paid plan, or external moderation service is enabled by this project. Model availability is verified against the Cloudflare catalog on 2026-10-29. The free account limit is the spending boundary; per-IP limits are additional abuse mitigation, not an exact global budget.

Guest uploads and generated images remain in the current page only. Logged-in text and upload content are included in saved conversations; generated images are private D1 media. History lists the 100 most recently updated conversations. A saved conversation is limited to 1.9 MB; save failures are visible and the current page stays available for export. Image output over 1.9 MB is temporary and must be downloaded. PDF text extraction is performed locally before extracted text is sent to Workers AI.

## Verification

`npm test` covers geographic spoofing, original topics, long/obfuscated content, cross-origin writes, guest history isolation, injected system roles, fail-closed semantic checks, image policy enforcement, request bounds and answer cleanup. `test/live-smoke.mjs URL` is an explicit live integration test requiring a local ignored `.credentials.json`; it exercises login, model calls, image generation and history CRUD using synthetic data. It consumes the existing free allocation.

Design refinement follows [Impeccable](https://github.com/pbakaus/impeccable): a restrained Operate/Read interface, consistent SVG icons, local assets, visible focus and responsive layouts.
