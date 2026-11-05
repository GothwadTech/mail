# Gothwad Mail

Webmail for `username@APP_DOMAIN` addresses. You sign in with **Gothwad Accounts**, and
your address comes from your username.

- **Web app**: React + Vite + Tailwind PWA (`src/`).
- **Mail Worker** (`worker/`): Cloudflare Worker. REST API under `/api/*`, plus the inbound
  Email handler.
- **Storage**: **Cloudflare D1** (`mail` database, binding `DB`) — 100% native, zero Supabase.
  Message bodies are gzip-compressed, so a free 500 MB database holds roughly 250,000 emails.
- **Outbound**: one pluggable provider (`worker/src/send/`) — Resend by default, Cloudflare
  Email Sending optional. Called only from the Worker; see [docs/SENDING.md](docs/SENDING.md).

Folders: **Inbox, Starred, Sent, Drafts, Trash**.

**Several accounts, one browser.** Up to six Gothwad accounts can stay signed in, exactly like
Gmail: every tab owns one account (`/u/0/`, `/u/1/`, …), and the profile avatar opens the
*shared* Gothwad account menu hosted by Accounts
(`${accountsWebOrigin}/widget/account-menu.js`) — the same sheet Accounts, Store and Console
show. Mail supplies the data and the handlers; it does not draw a second menu.

**Smart retention** (per user, in Settings): latest **500** (default), latest **1,500**, or
**Store All** up to a 50 MB fair-use quota. Starred emails and drafts are never auto-deleted;
Trash empties after 30 days.

No demo data. Mailbox ownership comes from the verified Accounts session; messages live in
Mail's own D1 database. Inbound addresses are checked through Accounts' internal API.

**Startup waits for identity only.** `GET /api/session?meta=0` is one Accounts verification and
no database work; the shell paints as soon as it answers. Unread badges and the send quota load
afterwards (`GET /api/session/meta`), with skeletons, a strip-local retry, and `null` instead of
a made-up zero. Details and local measurements: [docs/STARTUP.md](docs/STARTUP.md).

## Quick start (local)

```bash
npm install
cp .env.example .env.local           # public settings only; no secrets
cp worker/.dev.vars.example worker/.dev.vars   # local-only values

# Full preview: real Worker + REAL SQLite (node:sqlite), Resend and Accounts faked
npm run preview:api                  # API on http://127.0.0.1:8787
npm run dev                          # web app on http://localhost:3000 (proxies /api)
```

Prefer Wrangler's own local D1? Use `npm run worker:dev` instead of `preview:api`. Both
bootstrap the schema automatically — no SQL step, no database account.

Without a signed-in Accounts session the app sends you to Accounts. For local work set
`DEV_AUTH_USERNAME` in `worker/.dev.vars` (development only).

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Web app (Vite, port 3000) |
| `npm run preview:api` | Real Worker + local SQLite D1 + seeded demo mailbox (port 8787) |
| `npm run build` | Production build into `dist/` |
| `npm run lint` | Typecheck the web app and the Worker |
| `npm run test:worker` | Worker tests on real SQLite (no network) |
| `npm run test:d1` | D1 adapter, gzip and retention tests on real SQLite |
| `npm run test:auth` | Sign-in redirect/return URL tests (no network) |
| `npm run test:startup` | Shared/cancelled session requests and the identity-first startup |
| `npm run test:routing` | `/u/<n>/` URL routing, aliases and hash folders |
| `npm run test:assets` | Root-relative assets, one web manifest, service worker never caches `/api` |
| `npm run test:widget` | Account-widget contract: the `open(state, opts)` mapping and the loader |
| `npm run test:language` | Repository language hygiene (English only, no Hinglish in code or docs) |
| `npm run test:config` | Checks `worker/wrangler.toml` is complete, D1-bound and secret-free |
| `npm run test:ui` | jsdom smoke test of the real app (needs `preview:api` or `worker:dev`) |
| `npm run worker:dev` | Worker locally (`wrangler dev`, automatic local D1) |
| `npm run worker:deploy` | Deploy the Worker |
| `npm run worker:secrets` | Set the two Worker secrets (Wrangler prompts for values) |
| `npm run worker:secrets:list` | List the deployed Worker's secret **names** (never values) |

## Configuration

Public settings live in `worker/wrangler.toml` (`APP_DOMAIN`, `AUTH_HUB_URL`,
`AUTH_SIGNIN_URL`, `MAIL_URL`, `DAILY_SEND_LIMIT`, `MAX_INBOUND_BYTES`) plus the D1 binding.
The file is the source of truth and is re-applied on every deploy (`keep_vars = true` keeps
dashboard-only vars too). Secrets are only `ACCOUNTS_INTERNAL_TOKEN` and `RESEND_API_KEY`; set
them with `npm run worker:secrets` or in the dashboard as type **Secret**, never in a file.

After a deploy, `GET /api/health` shows live D1 readiness and which settings exist, as booleans
only:

```json
{"ok":true,"service":"gothwad-mail","engine":"cloudflare-d1-native",
 "environment":"production",
 "database":{"bound":true,"ready":true,"tables":2},
 "configured":{"d1Binding":true,"accountsInternalToken":true,"resendApiKey":true}}
```

`AUTH_HUB_URL` is the base for every server-side Accounts call and must reach the Accounts
Worker (`https://api.gothwadtech.com`, its Custom Domain). `AUTH_SIGNIN_URL` is used only for
browser-facing links — the sign-in redirect and `accountUrl` — and falls back to
`AUTH_HUB_URL` when unset.

Nothing in the code hardcodes the domain. Fallback defaults may use `gothwadtech.com`.

## Deploy

Follow **[docs/SETUP.md](docs/SETUP.md)**. It covers the D1 database, the two secrets, the
route, Email Routing and verification. Do not enable Email Routing until the Accounts username
endpoint is confirmed working.

The Worker is named `mail` in the Cloudflare dashboard and `worker/wrangler.toml` says
`name = "mail"`. Keep the two equal — Git deploys hide a mismatch, but local commands
(`npm run worker:deploy`, `npm run worker:secrets:list`) would target the wrong Worker.

## Docs

- [docs/SETUP.md](docs/SETUP.md): human setup steps (D1, secrets, deploy, verification).
- [docs/MAIL.md](docs/MAIL.md): how sign-in, storage, retention, sending and inbound work.
- [docs/STARTUP.md](docs/STARTUP.md): what the app waits for on boot, what it defers, and the
  measured local numbers.
- [docs/SENDING.md](docs/SENDING.md): outbound providers, how to switch, and the DNS records
  every option needs.
- [HANDOVER.md](HANDOVER.md): current state, how to verify it, and what is left to deploy.
- [AGENTS.md](AGENTS.md): rules for working on this repo.
- [PLAN.md](PLAN.md): status and open decisions.
- [TASK.md](TASK.md): session log.
- [sql/01_mail_schema.sql](sql/01_mail_schema.sql): documented D1 schema.

## Security notes

- The browser never gets any secret and never talks to D1. Only the Worker's `DB` binding
  reaches the database.
- Every mail query is scoped to the signed-in user's username.
- Email HTML is shown in a sandboxed iframe with no scripts.
- Writes from the browser must come from the app's own origin and send JSON.
- The send cap (default 30 a day per user) and the per-mailbox quota keep the free tier safe.

## Known limits

- Attachments: only name, type and size are kept. The bytes are not stored yet.
- Inbound is accounts-only: mail is kept only when Accounts' internal username endpoint confirms the name. Unknown names get a 550 bounce; lookup failures get 451. Email Routing stays off until the endpoint is confirmed working.
- No Undo for Trash. No restore from Trash yet.
- Refresh is manual. There is no polling.
