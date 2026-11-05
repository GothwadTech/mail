# PLAN.md — what's built, what's next

## Phase 2 — 100% Cloudflare native + smart retention (this branch)

| Area | Status | Notes |
| --- | --- | --- |
| Storage | **Done** | Cloudflare D1, database `mail`, binding `DB`. Zero Supabase. |
| Schema | **Done** | `mail_settings` + `mail_messages`, auto-bootstrapped on the first request (`worker/src/db.ts`, `WeakMap` per D1 instance). Same DDL documented in `sql/01_mail_schema.sql`. |
| Compression | **Done** | Bodies gzip-compressed into one `body_gzip` BLOB (`{t,h}` JSON). Legacy `body_text`/`body_html` still readable. Raw text capped at 100k chars, HTML at 250k, so a row never approaches D1's 2 MB limit. |
| Per-user quota | **Done** | `mail_settings.quota_bytes` = 50 MB compressed (~25k mails) protects the shared free 500 MB D1. `size_bytes` per row makes usage a single `SUM()`. |
| Retention | **Done** | 30-day Trash purge; starred + drafts immune; count cap 500/1500; "Store All" trims oldest unstarred trash first, then oldest mail. Runs on inbound, on send, and immediately on settings change. |
| Settings API | **Done** | `GET/PATCH /api/mail/settings` (CSRF-protected), returns live usage + `cleanup` counts. |
| Settings UI | **Done** | Storage progress bar + 3 retention choices + safety badge in `SettingsModal.tsx`, wired through `MailContext` and `mailApi`. |
| `/api/health` | **Done** | `engine: "cloudflare-d1-native"`, live `database: { bound, ready, tables }`, boolean `configured`. No Supabase fields. |
| Tests | **Done** | 91 tests. Worker tests (57) and D1 tests (15) run against **real** SQLite via `tools/local-d1.mjs` (Node 22 `node:sqlite`). |
| Local preview | **Done** | `npm run preview:api` runs the real Worker on local SQLite + seeded mailbox; Vite proxies `/api`. No Accounts/Resend needed. |
| Deploy config | **Done** | Worker `mail`, D1 `mail` (`database_id = 87854cea-7feb-46f3-ab99-2a2137f31105`), two secrets. Dry-run clean. |
| Docs | **Done** | README, AGENTS, TASK, PLAN, docs/MAIL.md, docs/SETUP.md, sql/ |

## Phase 2.5 — UI/UX + speed + PWA (this branch)

| Area | Status | Notes |
| --- | --- | --- |
| Conditional GET | **Done** | `ETag`/`304` on message detail; a repeat open skips gzip decompression and the download. |
| Folder + detail cache | **Done** | Cached list paints instantly, revalidates in the background; prefetch on hover/touch. |
| Bundle size | **Done** | Compose/Settings are lazy chunks; first paint ships the inbox only (87.95 kB gzip main). |
| Mobile layout | **Done** | `100dvh` + `min-h-0` flex shell, 5-folder bottom bar with unread badge, safe-area padding, skeletons. |
| Desktop layout | **Done** | Collapsible sidebar with unread badge, split reading pane, focus rings, `/` search shortcut. |
| PWA | **Done** | Manifest `display_override`/shortcuts, offline app shell, fonts + images cached, `/api/*` never cached. |
| Accessibility | **Done** | `prefers-reduced-motion`, visible focus, 44px+ targets, unread announced as text. |

## Phase 2.8 — Provider-neutral sending

| Area | Status | Notes |
| --- | --- | --- |
| Send adapter | **Done** | `worker/src/send/` with `resend.ts` + `cloudflare.ts`; `MAIL_SEND_PROVIDER` selects, unset auto-detects. Route unchanged. |
| Error contract | **Done** | Same `sending_not_configured` / `provider_rate_limited` / `send_failed` codes for every provider; provider codes are never echoed. |
| Optional Cloudflare Email Sending | **Ready, off** | Binding documented and commented in `wrangler.toml`. Needs Workers Paid ($5/mo), so it is the owner's call; docs/SENDING.md has the steps. |
| Visibility | **Done** | `/api/health` → `send.provider`, `configured.emailBinding`; send response includes `provider`. |
| Bounces/complaints | **Open** | No webhook/queue consumer yet; provider-specific. |
| Deploy | **Pending** | Local only. |

## Phase 2.7 — Startup: identity first (this branch)

| Area | Status | Notes |
| --- | --- | --- |
| Identity / metadata split | **Done** | `GET /api/session?meta=0` (one Accounts verification, zero D1) gates the shell; `GET /api/session/meta` brings unread badges + send quota afterwards. `/api/session` keeps its old shape for other consumers. |
| Honest unknowns | **Done** | Failed unread counts are `null` (a real empty mailbox is `{}`); a failed quota is `null`. The UI shows skeletons, then the number or a retry — never an invented zero. |
| Request sharing | **Done** | One in-flight request per endpoint + `authuser` selector (`services/sessionClient.ts`), aborted when the last consumer leaves, nothing cached after settle. |
| Stale-answer safety | **Done** | Attempt generations in `useSession` + `meta.authuser` check in `App`; a late answer for account A cannot paint account B, and an abandoned attempt cannot restore a signed-out view. |
| Send cap | **Unchanged** | Still counted and enforced inside `POST /api/mail/send`, independently of the delayed label. |
| Tests | **Done** | 181 pass, incl. `worker/test/session-meta.test.ts`, `tests/session-startup.test.ts`, `tests/ui-startup.test.tsx`. |
| Deploy | **Pending** | Local only. Worker + Pages deployment is the owner's step (see HANDOVER.md). |

## Phase 1 — Real app on the free tier (done earlier)

| Area | Status | Notes |
| --- | --- | --- |
| Worker REST API (`/api/*`) | Done, tested | Session, folders, read/star/trash, drafts, send |
| Accounts SSO (cookie) | Done | `/api/auth/me`; rotated cookies forwarded; 401 only for a real Accounts 401/403, everything else is a 503 with its own code (see `docs/MAIL.md`) |
| Accounts SSO (bearer) | Done, tested | `/api/oauth/userinfo`. Not used by the web app yet |
| Send via Resend | Done, not live-tested | Needs Resend key and verified domain |
| Daily send cap | Done | Default 30 (`DAILY_SEND_LIMIT`) |
| Inbound Email handler | Done in code, tested | Depends on Accounts username endpoint and shared secret; keep Email Routing off until verified |
| Frontend (API-backed) | Done | Visual check still worthwhile |

## Decisions made with the owner

1. **Mail is 100% Cloudflare native.** Workers + D1, no Supabase project, no PostgREST, no
   database key. This keeps the two free Supabase projects for the heavy social/realtime apps
   (PlusTube, Indogram, GrixChat).
2. **Mail has its own D1 database (`mail`)** and never reads the Accounts `accounts` database.
   Accounts is still the identity source over HTTP. Mailbox ownership is the normalized
   `to_username`.
3. **Bodies are compressed.** Gzip is the reason hundreds of thousands of mails fit in the
   free tier. Decompression happens only when a message is opened, never while listing.
4. **Retention is inline, not a cron.** Free Workers have no always-on scheduler, so cleanup
   runs on inbound, on send, and on settings change. Starred mail and drafts are sacred.
5. **Attachments: not now.** Only name, type and size are kept, and bytes are dropped. Storing
   files is a later step (needs R2 or a similar free-tier store).
6. **Local testing uses real SQLite.** `node:sqlite` + a D1-shaped adapter means tests exercise
   real CHECK constraints, indexes and BLOCs; no mock can drift from production SQL.

## Known gaps (not blocking)

- **Live Accounts SSO still needs verification** in production. The status codes in
  `docs/MAIL.md` name the failing branch.
- No Undo for moving to Trash. No "restore from Trash" yet.
- Search filters only the list already loaded in the browser.
- Sidebar folder counts are not shown (there is no cheap server count).
- No polling and no live updates. Refresh is manual.
- No automatic import of mail that lived in the old Supabase project. Export it manually
  before deleting that project (see `docs/SETUP.md`).
- Attachments metadata is kept, but there is no download because bytes are never stored.

## Phase 3 — later (not started)

- Tiny attachment storage on R2 (free tier) with a per-user cap.
- Threading (grouping replies).
- Restore from Trash.
- Server-side search (SQLite `LIKE` or FTS5).
- Optional scheduled cleanup with a Cron Trigger, as a safety net behind the inline runs.

## Phase 2.6 — Multi-account switcher

| Area | Status | Notes |
| --- | --- | --- |
| Accounts service (other repo) | **Blocked** | Prompt ready: `docs/ACCOUNTS_AGENT_PROMPT.md`. Per-account session cookies + active slot + switch API. |
| Mail proxy API | **Done** | `GET /api/mail/accounts`, `POST …/switch`, `POST …/signout`, `GET …/add` in `worker/src/accounts.ts`; 404 → `unsupported: true`. |
| Per-account unread | **Done** | One grouped D1 query, only for Accounts-verified usernames. |
| Switcher UI | **Done** | `AccountSheet` list with avatars, unread pills, active check, per-row sign-out, add-account; `+n` avatar bubble; `Shift+A`. |
| Instant switch | **Done** | Caches cleared, provider keyed by username, session re-read without a reload. |
| Local + automated verification | **Done** | Two-account dev stub; 14 worker tests + 1 jsdom switch test (108 total). |
| Live two-account check | **Pending** | Needs the Accounts PR deployed. |

## Code hygiene — file size policy

| Rule | Value |
| --- | --- |
| Target lines per source file | **≤ 500** |
| Hard maximum | **800** (test fails above it) |
| Enforcement | `npm run check:sizes`, first step of `npm test` |
| Already split | `worker/test/*` (11 files), `src/context/*` (7 files), `worker/src/mail-*` (4 files) |
| Largest file now | `src/context/useMailbox.ts` (312) |
