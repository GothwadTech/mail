# HANDOVER.md — where this repository stands

Last updated: 2026-10-24. Read this first if you are picking the work up.

## Latest: sending is provider-neutral

`worker/src/send/` holds one adapter per outbound provider (`resend.ts`, `cloudflare.ts`) and
`index.ts` chooses between them with `MAIL_SEND_PROVIDER` (`resend` | `cloudflare`; unset =
auto-detect). The send route, the daily cap, the Sent copy and the error codes are unchanged.
`/api/health` reports `send.provider`. Full guide: `docs/SENDING.md`.

Resend stays the default because it is free; Cloudflare Email Sending is implemented but disabled
(it needs the Workers Paid plan). Bounces/complaints are still not processed.

## Previous change (already merged): startup waits for identity only

The app used to block on one big `/api/session` call that also did database work (schema
bootstrap, send count, unread counts). It now waits for **identity only**:

* `GET /api/session?meta=0` — one Accounts verification, **zero D1 work**. This is the only thing
  that gates the shell. Implemented in `worker/src/sessionPayload.ts` (`identityPayload`).
* `GET /api/session/meta` — unread badges + send quota, loaded after the shell, never blocking.
  Failures stay `null` (never `0`), and the sidebar offers a strip-local retry.
* `GET /api/session` — unchanged combined response, kept for other consumers.
* `src/services/sessionClient.ts` — one in-flight request per endpoint + `authuser` selector,
  aborted when the last consumer leaves, nothing cached after it settles.
* `src/hooks/useSession.ts` (identity gate, attempt generations) +
  `src/hooks/useSessionMeta.ts` (deferred strip, `meta.authuser` check).

Full reasoning, contract and local measurements: `docs/STARTUP.md`.

## What is verified locally

```bash
npm ci
npm test        # 188 pass, 0 fail
npm run lint    # web + worker typecheck
npm run build   # 24 precache entries, 500.30 KiB
node tools/check-file-sizes.mjs                                   # 93 files, none > 500 lines
npx wrangler deploy --dry-run --config worker/wrangler.toml        # clean
```

UI tests need the local API: `npm run preview:api` (port 8787) before `npm run test:ui`.

## What is NOT done

* **Nothing is deployed.** The Worker and the Pages site still run the previous code. Local green
  tests say nothing about production latency.
* The local timing numbers (identity ≈ 0.9–1.1 ms vs full ≈ 1.2–2.5 ms; shell at 138 ms while the
  metadata was held for 2 s) come from `node:sqlite`, not from Cloudflare D1. Do not quote a
  production latency figure until it is measured in production.
* `GothwadTech/accounts` was not modified. Mail keeps compatibility with the existing Accounts
  response contract.

## Deploy steps (owner)

1. **Worker** (the new routes and the split payload):
   ```bash
   npx wrangler deploy --config worker/wrangler.toml
   ```
2. **Pages** (the new frontend): production root directory stays `/`; build command
   `npm run build`, output `dist`. Push to the branch Pages builds, or trigger a new deployment.
3. Verify in production: open Mail signed in and check the network panel —
   `GET /api/session?meta=0` first (shell paints), then `/api/session/meta` and
   `/api/mail/messages?folder=inbox` in parallel. A signed-out browser must still get a 401 with
   `signinUrl` and be sent to Accounts exactly once.

## Rules that must not be broken

See `AGENTS.md`. In short: Worker `mail`, D1 `mail`, binding `DB` (never rename); no manual SQL
(schema self-bootstraps); no secrets in the repo; every source file ≤ 500 lines; pure English in
repository files; account isolation (`/u/0..5`, `X-Gothwad-Authuser`, per-slot caches); private
responses `no-store`; never store session/OAuth tokens in Web or Cache Storage.
