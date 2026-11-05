# TASK.md — session log

Updated every session. Newest first.

## 2026-11-05 — Sending becomes provider-neutral (Resend is a choice, not a dependency)

**Owner request:** we use Resend to send mail — can we be independent of it? What is needed, and
is code + Cloudflare enough or does something else have to be arranged?

**Audit (facts, checked 2026-11):** a Worker cannot deliver mail itself — the runtime blocks
outbound port 25 — so some relay is always required. Cloudflare's own answer, Email Sending
(public beta since 2026-04), needs the **Workers Paid** plan for arbitrary recipients, includes
3,000 emails/month, and is not free. A self-hosted server needs a static IP, PTR, open port 25,
DKIM/SPF/DMARC and IP warm-up. So "no vendor at all" is infrastructure, not code; "not locked to
Resend" is code — and that is what was built (owner picked this option).

**What changed**

- `worker/src/send/` (new): `types.ts` (one `OutboundMail`), `resend.ts` (moved from
  `worker/src/resend.ts`), `cloudflare.ts` (the optional `send_email` binding) and `index.ts`,
  which picks the provider and throws Mail's own 503 when none is ready.
- `MAIL_SEND_PROVIDER` (`resend` | `cloudflare`, unset = auto-detect: Resend key, then binding).
  A named-but-unconfigured provider is a hard 503 plus a logged `send_provider_unknown` — never a
  silent fallback to another vendor.
- Nothing else in the send path moved: same validation, same `DAILY_SEND_LIMIT` check **before**
  the provider call, same gzip Sent copy (now with the provider id), same draft cleanup, same
  retention, same 429/502 codes and messages.
- `GET /api/health` now reports `send: { provider }` and `configured.emailBinding` (booleans and
  a name only). The send response adds `provider` next to `id`.
- `worker/wrangler.toml`: documented `MAIL_SEND_PROVIDER` plus a commented `[[send_email]]`
  block, so switching later is uncomment + one var.
- `docs/SENDING.md` (new): what sending actually requires, the three options with real 2026
  terms, DNS checklist, switch steps, and the known bounce-handling gap.

**Tests:** `worker/test/send-provider.test.ts` (7) — default Resend path unchanged, binding path
pays the same `From`/to/cc/subject and stores its message id, explicit-but-missing provider →
503 with nothing sent, auto-detect, 429/502 mapping (provider code never echoed), daily cap still
checked first, health names the provider without leaking a key.

**Verification:** `npm test` **188 pass** (worker 103, ui 19, d1 15, config 10, widget 9,
startup 7, routing 10, assets 7, auth 5, language 3); `npm run lint` clean; `npm run build`
clean; `npx wrangler deploy --dry-run` clean; every file under 500 lines.

**Not done:** nothing is deployed; Cloudflare Email Sending stays disabled (it needs $5/month,
which the owner's $0 rule forbids today). Bounces/complaints are still unhandled — the natural
next step for deliverability, and provider-specific.

## 2026-10-24 — Startup: identity first, metadata never blocks the shell

**Owner request:** the app sat on a full-screen "Loading your Gothwad Account" gate for too
long. Fix the real cause (audit for it, do not trust the prompt), keep authentication exactly as
strong, and do not break mail, the switcher or the drafts.

**What the audit found (measured, not assumed).** One `GET /api/session` request did everything
in series: Accounts `/auth/me` (with cookie rotation), then `Db.from()` **including the schema
bootstrap**, then `countSentToday`, then `unreadCounts` for every account, and only then the JSON
that unlocked the whole app. The last two steps only feed a badge and one line of text. A failing
unread query was even turned into `{}` — a fake "0 unread" — while a failing quota became `null`.

**What changed**

- `worker/src/sessionPayload.ts` (new): `identityPayload()` (no D1), `loadSessionMeta()`
  (unread + quota in parallel, each failing soft) and `fullPayload()` for the old shape.
- `GET /api/session?meta=0` → identity only, zero database work; `GET /api/session` unchanged;
  new `GET /api/session/meta` → `{ authuser, unread | null, limits }`. `authuser` tags the
  answer so a late response can be dropped. One Accounts verification per Worker request still.
- `worker/src/accountList.ts`: `unreadCounts()` returns `null` on failure instead of `{}`, so
  "unknown" and "empty" stay different.
- `src/services/sessionClient.ts` (new): one in-flight request per endpoint **and** account
  selector, shared by every consumer; the last release aborts the fetch; nothing is cached after
  it settles; no payload in Web/Cache Storage.
- `src/hooks/useSession.ts`: identity gate with attempt generations (late answers from an older
  attempt, an older account or an unmounted app are dropped). `applyAccount` resets `limits` to
  `null` so one account's quota is never shown on another.
- `src/hooks/useSessionMeta.ts` (new): the deferred strip — `loading` / `ready` / `error`,
  a retry that re-fetches only the strip, and a hard check that `meta.authuser` matches the
  account on screen.
- `src/App.tsx`: renders the shell from identity alone; metadata arrives later. `src/components/
  Sidebar.tsx`: quota skeleton, then the number or "Send limit unavailable — retry".
  `MailContext`/`useAccountsSwitcher` accept a late badge map instead of pretending it is empty.
- `tests/ui-harness.tsx`: `setApiInterceptor()` so a test can hold or fail one API path while
  everything else runs for real.

**Verification (exact commands)**

| Command | Result |
| --- | --- |
| `npm test` | **181 pass, 0 fail** (worker 96, ui 19, d1 15, config 10, widget 9, startup 7, routing 10, assets 7, auth 5, language 3) |
| `npm run lint` | clean (web + worker `tsc --noEmit`) |
| `npm run build` | built; 24 precache entries, 500.30 KiB |
| `node tools/check-file-sizes.mjs` | 93 files, none over 500 lines |
| `npx wrangler deploy --dry-run --config worker/wrangler.toml` | clean |
| `curl` 5x: full vs identity | full 1.2–2.5 ms, identity 0.9–1.1 ms (local SQLite) |
| Shell paint with meta held 2 s | shell 138 ms, strip 2152 ms |

**Not done / limits:** this is a local, tested change — **nothing is deployed** by this session.
The local numbers use `node:sqlite`, so they say nothing about production D1 latency; the honest
claim is that the shell no longer waits for unread/quota at all. Accounts' own startup was not
touched (that repository is read-only from here).


## 2026-10-22 — The account menu becomes the shared Accounts widget (audited, not copied)

**Owner request:** read `docs/MAIL_UNIVERSAL_ACCOUNT_MENU_PROMPT.md` from `GothwadTech/accounts`,
**audit both live repos first instead of trusting the brief**, build what is genuinely best,
keep every file at or below 500 lines, keep tests and the build green, and keep the docs honest.

**Audit — what the brief asked for vs. what the live code allows**

| Brief says | Live code | Decision |
| --- | --- | --- |
| Load `${accountsWebOrigin}/widget/account-menu.js`, call `window.GothwadAccountMenu.open(state, opts)` | Exists in `accounts@main`, exports exactly that (`open/update/close/isOpen`), served with `Access-Control-Allow-Origin: *` | Implemented as described |
| Replace Mail's `AccountSheet.tsx` | Mail's sheet was 329 lines of duplicated Google UI | Replaced with a thin host; the rows now live in Accounts |
| `accountHref`, `badges`, `theme`, `nextUrl`, `manageAccountHref`, `onSwitchAccount/SignOutAccount/SignOutAll` | All read by the live template | Passed, with Mail's own handlers doing the work |
| "`onSignOutAll`" | Mail had no such route | Added `POST /api/mail/accounts/signout-all` → Accounts `/auth/signout` |
| `user.avatarUrl` | Mail's session flattened the user to `{username,email,name}` | `/api/session` now returns `firstName`, `lastName`, `avatarUrl` (from Accounts' `presentUser`) |
| `accountsWebOrigin` derived in the browser | Mail's config already knows `AUTH_SIGNIN_URL` | Worker sends it in `/api/session`, so no domain is hardcoded in the bundle |
| "`Shift+A` and `↑/↓`/`Enter` inside the sheet" | The live widget only handles `Esc` | `Shift+A`/`Esc` work; arrow-key roving focus is requested from Accounts (documented gap, not faked in Mail) |
| "100% pure English everywhere, enforced by a test" | Repo had Hinglish in `TASK.md`, `docs/*`, `tools/*` | Docs + comments rewritten to English, `tests/language.test.ts` added, `tools/` and test fixtures exempt (they hold non-Latin mail bodies on purpose) |

**What was built**

- `src/services/accountWidget.ts` — one cached dynamic import (CORS module load, 5 s timeout),
  `requestIdleCallback` preload after session boot, and results instead of throws.
- `src/services/accountMenu.ts` — pure `buildAccountMenu()` mapping Mail state → widget
  `(state, opts)`: user with photo, accounts with real avatars, `activeId`, `authuser`, `theme`,
  unread `badges`, `accountHref → /u/<n>/`, `nextUrl`, `manageAccountHref`, extras + handlers.
- `src/components/AccountSheet.tsx` — the host: opens on the tapped avatar, pushes `update()`
  while open, mirrors the widget's own close, and falls back to
  `AccountSheetFallback.tsx` (compact in-app sheet, full keyboard support) if the script cannot
  load. The avatar is therefore never dead.
- `src/components/AccountAvatarButton.tsx` — one avatar button (photo or monogram, `+n` bubble)
  used by both the mobile and the desktop header; the tapped element is the widget's anchor.
- `tools/account-menu-widget.stub.js` — the dev server serves it at `/widget/account-menu.js`
  with the real API, so `npm run dev` and the jsdom tests exercise the same path as production.
- `docs/ACCOUNTS_AGENT_PROMPT.md` — addendum listing the exact contract Mail depends on plus the
  two changes requested from Accounts (arrow-key model in the sheet, stable widget URL).

**Tests:** 162 pass (`npm test`), including the new `tests/account-widget.test.ts` (mapping, URL
building, loader single-import and failure paths), 11 rewritten UI tests that install the widget
stand-in and drive the real callbacks, worker tests for `signout-all` and the new session identity
fields, and `tests/language.test.ts`. `npm run lint`, `npm run build` (309 kB, 92.4 kB gzip) and
`npx wrangler deploy --dry-run` are clean; every file is under 500 lines.

## 2026-10-21 — Gmail-level multi-account: `/u/<n>/` URLs, per-tab isolation, hard 500-line rule

**Owner request:** make the switcher behave exactly like Google's — every tab its own account,
the account visible in the URL, and never a row from one account inside another account's frame.
Also make the file-size rule actually enforced.

**What changed**

- **URL is the state.** Canonical `/u/<n>/#<folder>`. Aliases (`/mail/u/n/`, `/?authuser=n`,
  `/?u=n`, `/?login=1&authuser=n`, `/?folder=`) are rewritten once with `replaceState`
  (`src/services/authuser.ts`). One-shot params (`compose=1`, `__mail_auth_return=1`) survive the
  rewrite; the folder lives only in the hash, so folder nav never touches the account.
- **One account per tab.** Every API call sends `X-Gothwad-Authuser: <n>`; the Worker validates
  it and forwards it to Accounts as the tab selector (`worker/src/authuser.ts`). Two tabs, one
  cookie jar, two mailboxes — verified by `worker/test/multitab.test.ts` (parallel reads, send
  From, cross-account 404).
- **Paint order.** `MailProvider` keyed by slot id + per-slot caches
  (`src/services/mailboxCache.ts`), and switching is optimistic: flush draft → URL + session →
  background `POST /switch`. The UI test records **every** painted frame and asserts no frame
  shows bob's list with an alice row.
- **Accounts numbering is respected.** `parseAccounts` sorts by Accounts' `authuser` before
  numbering 0..n, and an upstream `accountUrl` is used verbatim; a promoted account therefore
  really is the index the UI navigates to (regression found by the sign-out UI test).
- **Sign-out per account**, active or not: the shown account's hop goes to the promoted slot and
  drops that mailbox cache; the inactive one leaves the open mailbox untouched.
- **Keyboard + layout:** `Shift+A` opens the sheet, `↑/↓` move, `Enter` switches, `Esc` closes;
  `role="dialog"`, focus starts on the active row; safe-area bottom padding on phones.
- **Deep links:** `public/_redirects` (`/u/*`, `/mail/u/*` → `/index.html` 200), `public/_headers`
  (`max-age=0, must-revalidate`), `appType: 'spa'`, and one manifest only (`manifest: false` in
  the PWA plugin — it used to emit a second, differently-iconed copy).
- **Hard 500-line rule:** `tools/check-file-sizes.mjs` now fails over 500 (no 800 escape hatch)
  and covers `.js/.css/.html/.sql/.md`. `TASK.md` was 663 lines, so its older sessions moved to
  `docs/TASK_ARCHIVE.md` (nothing deleted).

**Tests:** 141 pass (`npm test`) — worker 82, UI 12, D1 15, config 10, auth 5, routing 10,
assets 7, plus the size gate. `npm run lint`, `npm run build` (308 kB / 91.7 kB gzip) and
`wrangler deploy --dry-run` clean. Fixed on the way: the SPA rewrite dropped
`__mail_auth_return`, and the dev Accounts stub had a stale `authuser` after sign-out.

## 2026-10-20 — File size rule (500 target / 800 max) + the splits it required

**Owner request:** write the rule down permanently — keep every code file within 500–800 lines,
aiming for 500; split any file that is already bigger into parts **without changing behaviour or
logic**. Do not just document it: follow it now.

**Rule (AGENTS.md #12, now enforced, not a note):**

- target **≤ 500 lines**, hard max **800**, per `.ts` / `.tsx` / `.mjs`
- over 500 → split in the same session; behaviour identical (same exports, same logic, same
  user-visible text, same tests)
- docs/lock/CSS/JSON/generated output exempt
- `npm run check:sizes` (`tools/check-file-sizes.mjs`) fails > 800, warns > 500, and runs as
  the **first** step of `npm test`, so it does not depend on anyone remembering the rule

**Splits done in this session (all behaviour-preserving):**

| Before | After |
| --- | --- |
| `worker/test/worker.test.ts` **1291** | `helpers.ts` 262 + `health` 68, `session` 260, `messages` 142, `mutations` 121, `drafts` 64, `send` 118, `settings` 96, `inbound` 173, `misc` 60, `accounts` 255 |
| `src/context/MailContext.tsx` **944** | `MailContext.tsx` 252 (composition) + `mailContextTypes.ts` 141, `mailHelpers.ts` 69, `useMailbox.ts` 312, `useCompose.ts` 180, `useMailboxSettings.ts` 80, `useAccountsSwitcher.ts` 119 |
| `worker/src/mail.ts` **527** | `mail.ts` 19 (barrel) + `mail-types.ts` 187, `mail-read.ts` 86, `mail-write.ts` 271 |

Test harness: one `helpers.ts` with real in-memory SQLite + a replaceable upstream stub, and a
live `h` object (`h.env`, `h.stub`, `h.seen`) so every test file shares the same beforeEach
wiring. `test:worker` now runs `worker/test/*.test.ts`.

`toEmailMessage` / `toComposeData` are still re-exported from `MailContext`, so components did
not change. `useMail()` contract is untouched.

**Verified:** `npm run lint` clean, `npm run check:sizes` clean (57 files), `npm test` →
**108 pass** (config 10, auth 5, worker 72, d1 15, ui 6), `npm run build` OK
(304.41 kB / 90.21 kB gzip), preview + `/api/mail/accounts` still fine. `dev-dist/` added to
`.gitignore`.

---

## 2026-10-20 — Account switcher built on the Mail side (Google flow), tested end to end

**Owner request:** the prompt has been handed to the Accounts agent; build the Mail side in
parallel with Google's flow: one profile section, every signed-in account, a ~1 second switch on
tap.

**Backend — `worker/src/accounts.ts` (new)**

- `GET /api/mail/accounts`: proxies Accounts' list, then adds **per-account unread counts** from
  Mail's D1 in one grouped query, only for usernames Accounts just verified.
- `POST /api/mail/accounts/switch` `{id}`: proxies the switch, forwards rotated `Set-Cookie`
  (reuses `keepAccountsCookies`), 401 only when Accounts really says signed out, 409
  `account_not_signed_in` when the slot's session is gone.
- `POST /api/mail/accounts/signout` `{id}`: per-account sign-out.
- `GET /api/mail/accounts/add`: 302 to `{AUTH_SIGNIN_URL}/signin?choose=1&add=1&next=…`, built
  from config (no open redirect).
- Accounts 404 (feature not deployed) → `{ accounts: [], unread: {}, unsupported: true }`, so
  Mail ships first and lights up later. Validation drops bad slot ids/usernames/duplicates, and
  emails are derived server-side.
- 14 new worker tests on real SQLite with a stubbed Accounts (72 total).

**Frontend**

- `mailApi`: `getAccounts`, `switchAccount`, `signOutAccount` + `AccountSummary`/`AccountsInfo`.
- `useSession`: `refresh()` re-reads the session **without** the full-screen loading state.
- `MailContext`: accounts state (`accounts`, `activeAccountId`, `accountUnread`,
  `accountsUnsupported`, `switchingAccountId`), `refreshAccounts` (one GET per page load, no
  polling), `switchAccount` (clears folder/detail/prefetch caches, selection, draft, then asks App
  to re-read the session), `signOutAccount`.
- `App.tsx`: `<MailProvider key={user.username}>` → a switch remounts the provider, so no cache
  can survive an account change.
- `AccountSheet`: the real switcher — avatar + name + address + unread pill + check on the active
  row, spinner on the row being switched, per-row sign-out (confirm only for the last account),
  “Add another account”. Single-account fallback card when Accounts has not shipped yet.
- `Header`: `+n` bubble on the avatar when more accounts exist, `Shift+A` opens the sheet.
- `tools/dev-server.mjs`: two-account Accounts stub (alice/bob) driven by a `gothwad_active`
  cookie, so the preview and the UI test exercise the real switch path.

**Verified**

- `npm run lint` clean. `npm test` → **108 pass** (config 10, auth 5, worker **72**, d1 15,
  ui **6** — the new one opens the switcher, taps bob, and asserts the app is fully bob after).
- Manual: `GET /api/mail/accounts` → alice+bob with unread; `POST switch {id:"b"}` → 200,
  `set-cookie: gothwad_active=b`; `GET /api/session` with that cookie → `bob@gothwadtech.com`.
- `npm run build` → main 302.40 kB (89.84 kB gzip); still one lazy chunk per modal.

**Pending:** live check with the two real accounts once the Accounts PR lands.

---

## 2026-10-20 — Multi-account switcher: plan + Accounts-side prompt (docs only, no code)

**Owner request:** a Google-style account section — every signed-in Gothwad account in one
place, avatar plus unread count, a tap switching to that mailbox in about a second. Today Mail
shows a single address even though `accounts.gothwadtech.com` holds two sign-ins.

**Finding:** this cannot be fixed inside Mail alone. `worker/src/session.ts` asks Accounts for
**one** identity per request, and Accounts keeps a single session per browser. Forcing Mail to
keep its own account list would mean storing other accounts' credentials in Mail, which is not
allowed. No data migration is needed either: every row is already scoped by `username`.

**Deliverables (docs only this session):**

- `docs/ACCOUNTS_AGENT_PROMPT.md` — self-contained prompt for the Accounts agent: per-account
  session cookies (`gothwad_sess_a..f`), HMAC-signed `gothwad_accounts` list, `gothwad_active`,
  and four endpoints (`GET /api/auth/accounts`, `POST /api/auth/switch`,
  `POST /api/auth/accounts/:id/signout`, `GET /signin?choose=1&add=1`). Includes the cookie
  constraints Mail's proxy depends on, 8 required tests, and legacy single-account fallback so
  nothing breaks.
- `docs/MULTI_ACCOUNT_PLAN.md` — Google-parity behaviour table, Mail-side work (proxy endpoints
  in a new `worker/src/accounts.ts`, session plumbing + cache reset, switcher UI in
  `AccountSheet`, instant switch), security checklist, 12 acceptance tests, $0 cost, rollback.

**Key design decisions:**

- **Server-side path resolution, not a client header.** The active account is a cookie resolved
  by Accounts, so `GET /api/auth/me` keeps returning one identity and `session.ts` needs no change.
- **Mail proxies Accounts, no CORS.** Reuses `takeUpstreamCookies` so `Set-Cookie` rotation is
  forwarded exactly as it is today.
- **404 fallback = hidden switcher.** Mail can ship first and light up when Accounts deploys.
- **Caches cleared before first paint on switch** (privacy, not just freshness).
- Unread per account is computed in Mail's D1 for Accounts-verified usernames only.

**Blocked on:** Accounts repo (Part A). Mail-side Part B starts when that contract exists.

---

## 2026-10-20 — Fast, mobile-first UI + PWA polish (layout, caching, ETag)

**Owner request:** make the webmail feel right on mobile and desktop, keep the UI simple, make
it lightweight/fast with caching so Cloudflare does not redo work for already-seen mail, and
make PWA support solid.

**Backend (why: less work for repeated reads)**

- `GET /api/mail/messages/:id` now sends an **ETag** built from cheap columns only
  (`id`, `is_read`, `is_starred`, `size_bytes`, `received_at`) and answers **304** when the
  client's `If-None-Match` matches. The gzip decompression is skipped entirely on a 304.
  `Cache-Control: private, no-cache` keeps it per-user and always revalidated.
- `DETAIL_COLUMNS` now includes `size_bytes` (the tag was otherwise built from `undefined`).
- New helpers in `worker/src/mail.ts`: `getMessageRow`, `messageEtag`, `etagMatches`.
- Test: revalidation returns 304 with an empty body; a PATCH invalidates the tag.

**Frontend (why: instant, native feel)**

- `MailContext`: per-folder memory cache (paint cached list, revalidate in the background with
  a thin progress strip; a failed refresh keeps the cached list), detail cache,
  `prefetchEmail()` on hover/touch/focus, `isRefreshing`, `unreadInboxCount`.
- `App.tsx`: `100dvh` shell with flex `min-h-0` (no `calc(100vh-...)`), lazy-loaded
  `ComposeModal`/`SettingsModal` (separate ~8 KB chunks), unread count in the tab title,
  `${'/'}` focuses search, deep links `/?folder=` and `/?compose=1` for PWA shortcuts.
- `EmailList`: skeleton rows instead of a spinner, unread dot, 60px tap targets, keyboard
  open on Enter, `overscroll-contain`, revalidation strip.
- `EmailDetail`: message iframe fills the available height (no nested scroll), skeleton body,
  attachments in a bordered footer, bottom safe-area padding.
- `MobileBottomNav`: 5 folders + unread badge + active indicator, round compose FAB,
  `env(safe-area-inset-bottom)` padding. `Sidebar`/`MobileDrawer`: unread badge, collapse width.
- `index.css`: `prefers-reduced-motion` support, 16px inputs on mobile (no iOS zoom),
  `overscroll-behavior`, height roots.
- `index.html`: non-blocking Google Fonts (system font first, swap when ready).
- `manifest.json`: `display_override`, orientation, categories, 3 shortcuts, `id`.
  `vite.config.ts`: Workbox `navigateFallback`, **`/api/*` excluded from the SW cache**,
  font + image runtime caching, `skipWaiting`/`clientsClaim`.

**Verified**

- `npm run lint` pass. `npm test` → **93 pass** (config 10, auth 5, worker 58, d1 15, ui 5).
- `npm run build` → main `index` 295.34 kB (87.95 kB gzip) + `ComposeModal` 8.74 kB +
  `SettingsModal` 8.28 kB lazy chunks; SW precache 31 entries.
- Live preview: `If-None-Match` on a message returned **304 with 0 bytes**; folder switching
  and the Settings retention toggle still work.

---

## 2026-10-20 — Clarify the Builds settings: keep Root directory `/`, set the Preview command

**Report:** while fixing the red PR check, the owner changed the **Production** Root directory
from `/` to `worker`. The dashboard's Previews tab does have a **Preview command** field, so no
file move is needed.

**Correction captured in `docs/SETUP.md`:**

- Root directory stays **`/`** for Production **and** Previews. `package.json`, `node_modules`
  and `worker/` all live at the root, and `--config worker/wrangler.toml` is relative to it.
  Root = `worker` would break production twice: `npm ci` finds no `package.json`, and the
  config path would resolve to `worker/worker/wrangler.toml`.
- Production: Build command `npm ci`, Deploy command `npm run worker:deploy`.
- Previews: Build command `npm ci`, **Preview command**
  `npx wrangler preview --config worker/wrangler.toml`.
- Then retry the failed build. The `previews = {}` block in `worker/wrangler.toml` is what
  `wrangler preview` needs once it can see the config.

No application code changed in this entry.

---

## 2026-10-20 — Fix red "Workers Builds: mail" check (missing `previews` block)

**Root cause:** Workers Builds runs `npx wrangler deploy` on `main`, but
`npx wrangler preview` on non-production branches. Since Worker Previews shipped,
`wrangler preview` refuses to start without a `previews` block, so every PR build failed
before compiling anything (the same check was already red on PR #7, which still merged).

**Done (merged in PR #8):** `previews = {}` in `worker/wrangler.toml`, kept empty on purpose so
a Preview has no D1 binding and no secrets and can never touch production mail. Guarded by
`tests/worker-config.test.ts`; documented in `AGENTS.md` and `docs/SETUP.md`.

**Verified:** `npx wrangler preview --config worker/wrangler.toml` gets past the config check
and stops only at the expected local-only `CLOUDFLARE_API_TOKEN` error, which Workers Builds
provides.

---

---

Older sessions (D1 migration, the worker-name/URL fixes, the first real UI) are in
[`docs/TASK_ARCHIVE.md`](docs/TASK_ARCHIVE.md).
