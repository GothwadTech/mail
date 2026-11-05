# AGENTS.md — rules for working on Gothwad Mail

Read this before you change anything. Keep it up to date. Do not delete it.

## What this repo is

Gothwad Mail is a webmail app for `username@APP_DOMAIN` addresses.

- **Frontend**: Vite + React + Tailwind (`src/`). Calls same-origin `/api`. Has no secrets.
- **Mail Worker** (`worker/`): Cloudflare Worker. Serves the REST API under `/api/*` and
  handles inbound email (Email Routing `email()` handler). It is the only thing that
  talks to D1 (the `DB` binding) and one pluggable outbound provider
  (`worker/src/send/`, docs/SENDING.md).
- **Database**: **Cloudflare D1**, database **`mail`**, binding **`DB`** (`wrangler.toml`).
  Zero Supabase. The Worker bootstraps the schema itself on the first request
  (`worker/src/db.ts`); `sql/01_mail_schema.sql` is the documented copy and
  `sql/00_d1_console_bootstrap.sql` the comment-free console copy. Never put `PRAGMA` in D1
  SQL. Mail does not read the Accounts `accounts` database.
- **Identity**: Gothwad Accounts. Mail never has its own login. It asks Accounts who is
  signed in (`/api/auth/me` with the browser's cookies, or `/api/oauth/userinfo` for bearer
  tokens). Inbound mailbox checks also use an Accounts endpoint; Mail never reads Accounts'
  database. Two URLs, two jobs: `AUTH_HUB_URL` is the base for **every server-side Accounts
  fetch** and must reach the Accounts Worker (its Custom Domain, `api.gothwadtech.com`);
  `AUTH_SIGNIN_URL` is for **browser links only** (the 401 `signinUrl` and `accountUrl`) and
  falls back to `AUTH_HUB_URL` when unset.

Read `docs/MAIL.md` for how it works and `docs/SETUP.md` for the human setup steps.

## Hard rules (from the project owner)

1. **Do not edit the Accounts repo** (`GothwadTech/accounts`). Do not invent Accounts
   endpoints. An endpoint may be used only if it is documented in that repo; read it
   read-only to confirm the path and response before relying on it. If an owner supplies a
   contract before Accounts documents it, keep production traffic disabled until the docs
   and deployed behavior are confirmed. Do not merge Mail into Accounts.
2. **Never hardcode the domain in logic.** Use env: `APP_DOMAIN`, `AUTH_HUB_URL`,
   `AUTH_SIGNIN_URL`, `MAIL_URL`. The D1 database id and name are not secrets and live in
   `wrangler.toml`. Fallback defaults may contain `gothwadtech.com`.
3. **Never commit real keys.** `.env.example` and `wrangler` examples hold placeholders
   only. Only two Worker secrets exist: `ACCOUNTS_INTERNAL_TOKEN` and `RESEND_API_KEY`. They
   go in with `wrangler secret put` (or `npm run worker:secrets`) or the dashboard as type
   **Secret**. Never ask the user to paste a live key or password into chat.
4. **Browser never calls D1 or a mail provider.** The browser only calls same-origin `/api/*`. D1 is
   reached solely through the Worker's `DB` binding; there is no database URL or key to leak.
5. **No demo data in the production build.** No fake names, no mock threads.
   The only data is what the Worker returns.
6. **Free tier only. Zero paid budget.** No paid services, no paid add-ons.
7. **No polling loops.** Refresh is manual (or on user action). A background revalidation of
   a cached list is allowed only as the direct result of navigating to that folder.
7b. **Never auto-delete starred mail or drafts.** Retention (`worker/src/retention.ts`) may
   trim unstarred inbox/sent overflow, purge Trash after 30 days, and enforce the per-mailbox
   quota, but `is_starred = 1` and `folder = 'drafts'` are always excluded. Keep it tested.
7c. **Never store raw bodies.** Bodies go through `compressBodies()` into `body_gzip`, and
   `size_bytes` is always set, because the quota depends on it. Cap text/HTML before gzip.
8. **Attachments: tiny only (under 200 KB total), otherwise skip with a note.**
   Today: attachment bytes are never stored. Only name, type and size are kept, and the UI
   says so. Storing tiny files is a future decision (see `PLAN.md`).
9. **Per-user daily send cap** (default 30, range 20–50). Config: `DAILY_SEND_LIMIT`.
10. **Keep the existing visual design.** Replace mocks with API hooks; do not restyle.
11. **Comment the "why" in code**, not the "what". Keep comments short and plain.
11b. **Never cache mail in the service worker.** `vite.config.ts` excludes `/api/*` on
   purpose: mail is private and the SW is shared across sessions. Client memory caches in
   `MailContext` are fine (they die with the tab).
11c. **Keep repeated reads cheap.** `GET /api/mail/messages/:id` must keep its ETag/304 path:
   run the cheap row query first and decompress only when the validator does not match. Anything
   added to `DETAIL_COLUMNS` is read on every open, so keep it small.
11e. **Never let an account cache cross accounts.** `App.tsx` keys `MailProvider` by username and
   `switchAccount` clears the folder/detail caches before the next paint. Do not "optimise" that
   away: one mailbox's rows shown to another account is a privacy bug.
11f. **The account list belongs to Accounts.** Mail only proxies it (`worker/src/accounts.ts`).
   Never store another account's credentials or session token in Mail. Unread counts may only be
   computed for usernames Accounts just returned.
11g. **One account menu in the whole ecosystem.** Mail never draws its own switcher. It loads
   Accounts' shared widget from `${accountsWebOrigin}/widget/account-menu.js` (origin comes from
   the session, never a hardcoded domain), preloads it on boot, and hands it Mail's data plus
   Mail's handlers (`open(state, opts)`). Switching, drafts, caches and sign-out stay in Mail's
   own code. `src/components/AccountSheetFallback.tsx` exists only for the case where that
   script cannot load; it must never become the default.
11e. **Every tab owns one account.** Canonical URL is `/u/<n>/[#folder]`; every request carries
   `X-Gothwad-Authuser: <n>`, and the Worker passes it to Accounts as the tab selector. Never
   read or write another tab's account, and never let an old account's row paint after a switch
   (`MailProvider` is keyed by slot id).
11d. **Keep the shell responsive.** Use `100dvh` + flex `min-h-0` (no magic pixel heights),
   keep tap targets >= 44px, and keep `SettingsModal`/`ComposeModal` lazy-loaded so the first
   paint stays small.
12. **File size limit — hard 500 lines, enforced.**
    - Every `.ts` / `.tsx` / `.mjs` / `.js` / `.css` / `.html` / `.sql` / `.md` file stays
      **at or below 500 lines**. There is no 800-line escape hatch any more.
    - If a file crosses 500, split it **in the same session** — never "later".
    - When you find an existing file over 500, split it as part of your change.
    - Splitting must be **behaviour-preserving**: same exported names, same logic, same
      error messages, same user-visible text, same tests passing. Move code; do not rewrite
      it in the same commit as the split.
    - Split by responsibility, not by line count: read path / write path / validation,
      or one hook per concern. A file with two unrelated exports is already a signal.
    - Exempt only: `package-lock.json`, JSON data, and generated output (`dist/`, `dev-dist/`).
    - Enforced by `npm run check:sizes`, which **fails** over 500. It runs first inside
      `npm test`, so a regression cannot merge quietly.
    - Long session logs are archived, not deleted: `TASK.md` keeps recent sessions and points
      at `docs/TASK_ARCHIVE.md`.
    - Current split for reference: `MailContext.tsx` (provider composition) +
      `mailContextTypes.ts`, `mailHelpers.ts`, `useMailbox.ts`, `useCompose.ts`,
      `useMailboxSettings.ts`, `useAccountsSwitcher.ts`; and `worker/src/mail.ts`
      (barrel) + `mail-types.ts` / `mail-read.ts` / `mail-write.ts`; Worker tests are one
      file per area over `worker/test/helpers.ts`.
13. **English in the repository, simple English or Hinglish in chat.**
    - Every UI string, code comment, test name, commit message and document in this repository is
      written in English. Enforced by `npm run test:language` (scans `src/`, `worker/src/`,
      `docs/` and the root Markdown files).
    - Chat with the owner can be simple English or Hinglish; that is a conversation, not a file.
    - Test fixtures may contain non-Latin text on purpose: they prove mail bodies survive
      encoding, and `tests/` + `tools/` are excluded from the scan.
14. **Update `TASK.md` every session.**
15. **Never delete `AGENTS.md` once created.**

## Working rules

- Work only on the active Arena session branch (not `main`). Push only to it.
- Check the worker with `worker/tsconfig.json`. Do **not** run the root tsconfig over
  `worker/` (the DOM and workers libs clash). The root tsconfig excludes `worker/`.
- Before you say something works, run the checks:
  - `npm run check:sizes` (no file over 500 lines)
  - `npm run lint` (root and worker typecheck)
  - `npm run build`
  - `npm run test:worker` (Worker tests on real SQLite, no network)
  - `npm run test:d1` (D1 adapter, gzip and retention tests on real SQLite)
  - `npm run test:auth` (sign-in return URL tests, no network)
  - `npm run test:config` (after touching `worker/wrangler.toml`; config guard)
  - `npm run test:language` (English-only repository, no Hinglish in code or docs)
  - `npm run test:widget` (`buildAccountMenu` mapping + widget loader contract)
  - `npm run test:routing` (Gmail-style `/u/<n>/` URLs, no network)
  - `npm run test:assets` (root-relative assets, one manifest, SW never caches `/api`)
  - `npm run test:ui` (jsdom smoke test; needs `npm run preview:api` or `npm run worker:dev`
    running. See `docs/SETUP.md`, "Local development")
- `wrangler deploy --dry-run` should bundle cleanly before any deploy.
- Read big files in small `sed -n` ranges. Do not `cat` a huge file in one go.
- Local secrets go in `worker/.dev.vars` (git-ignored). Never commit it.
- Do not add `[[routes]]` or change production DNS/Email Routing from code. Those are
  human steps in `docs/SETUP.md`.

## Known things not to retry

- Do **not** reintroduce Supabase, PostgREST HTTP calls, `SUPABASE_URL` or a database service
  key. Storage is D1 through the `DB` binding; `npm run test:config` fails on any Supabase
  setting in `wrangler.toml`.
- Do **not** run `PRAGMA` in D1 SQL (remote D1 rejects it with `SQLITE_AUTH`), and do not drop
  `sqlite_sequence`/manual migration steps: the schema bootstrap is idempotent by design.
- Do **not** make retention delete starred mail or drafts, and do not make it a cron-only job.
  It must run inline on inbound/send/settings change because there is no always-on scheduler.
- Do **not** store bodies as plain `body_text`/`body_html` for new rows. Use
  `insertMessage()`/`saveDraft()`, which gzip and set `size_bytes`; a missing `size_bytes`
  breaks the quota.
- Do **not** "fix" a test by mocking the database. Tests use `tools/local-d1.mjs` on purpose;
  a mock would not catch SQLite constraint or SQL mistakes.
- Draft autosave duplicated drafts when the draft id was read from a stale closure. Fixed
  with refs and a single-flight flush in `MailContext.tsx`. Keep it that way.
- `decodeURIComponent` throws on bad `%` input. It is wrapped and returns 400.
- The Worker must forward rotated `gothwad_*` Set-Cookie headers from Accounts to the
  browser. Dropping them signs the user out of Accounts (refresh-token rotation).
- Do **not** collapse an Accounts answer Mail cannot read (3xx, HTML, missing `authenticated`,
  unusable username) into a signed-out 401. That made a broken Accounts handoff look like an
  expired session and bounced users through the chooser. Mail returns 401 only for an Accounts
  401/403; everything else is a 503 with its own code (`accounts_user_invalid`,
  `accounts_unexpected_response`, `auth_unavailable`). See the table in `docs/MAIL.md`.
- Do **not** remove `keep_vars = true` from `worker/wrangler.toml`, and do **not** leave the
  D1 `database_id` as a placeholder. Plain-text dashboard variables are replaced or deleted by
  every deploy; secrets are not. The file is the source of truth for the vars it names.
  `npm run test:config` (`tests/worker-config.test.ts`) fails on a blank var, a missing
  `keep_vars`, a wrong/missing D1 binding, any Supabase setting, or a secret-shaped value.
- Do **not** delete `previews = {}` from `worker/wrangler.toml`. Workers Builds runs
  `npx wrangler preview` for every non-production branch, and that command refuses to start
  without a `previews` block - which is why PR checks showed a red "Workers Builds: mail".
  Keep it EMPTY: a preview then has no D1 binding and no secrets, so unreviewed branch code
  can never read or trim production mail. `npm run test:config` guards this.
- Do **not** rename the Worker in `worker/wrangler.toml`. The deployed Worker is `mail` in the
  dashboard, so the file must say `name = "mail"`. Workers Builds overrides the config name with
  `WRANGLER_CI_OVERRIDE_NAME`, so a mismatch still deploys fine from Git but makes
  `npm run worker:secrets:list` and `npm run worker:deploy` target a different (non-existent)
  Worker. Fix the file, never the dashboard: `mail` holds the secrets, the
  `mail.gothwadtech.com/api/*` route and the Email Routing catch-all.
- Do **not** put secret values in `wrangler.toml` or make `/api/health` return anything more
  than booleans about which settings exist. It is a public endpoint; values never go there.
- Do **not** point `AUTH_HUB_URL` at the Accounts Pages host
  (`accounts.gothwadtech.com`). Cloudflare does not invoke a same-zone Worker attached by a
  Route for a server-to-server call, so Mail got `200 text/html` from the SPA and reported 503
  `accounts_unexpected_response`. Server-side calls go to the Accounts Custom Domain
  (`api.gothwadtech.com`); browser links go to `AUTH_SIGNIN_URL`.
