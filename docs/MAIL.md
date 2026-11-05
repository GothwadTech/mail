# How Gothwad Mail works

## The pieces

```
Browser ──► mail.gothwadtech.com
             ├─ static web app (Pages)            src/
             └─ /api/*  ──► Mail Worker           worker/src/index.ts
                              ├─► Accounts: who is signed in?   AUTH_HUB_URL/api/auth/me
                              ├─► Cloudflare D1 (`mail` DB)     mail_settings + mail_messages
                              └─► outbound provider             outbound mail
                                  (Resend or Cloudflare, docs/SENDING.md)

Internet mail ──► Email Routing (catch-all) ──► Mail Worker email()
                                                   ├─► Accounts username endpoint
                                                   └─► Cloudflare D1 (`mail` DB)
```

- The **browser** never has a mail-provider key and never talks to D1. It only calls `/api/*`
  on the same origin.
- The **Mail Worker** is the only place that holds secrets. Only two exist:
  `ACCOUNTS_INTERNAL_TOKEN` and the outbound provider key (`RESEND_API_KEY` today).
- **Accounts** is the source of truth for who is signed in. Mail never stores passwords and
  never makes its own login. Mail has its own D1 database (`mail`) and never reads the
  Accounts database.
- **Storage is 100% Cloudflare native**: Workers + D1. There is no Supabase project, no
  PostgREST call and no database key.

### The two Accounts URLs

| Var | Used for | Value |
| --- | --- | --- |
| `AUTH_HUB_URL` | **Every server-side fetch** Mail makes to Accounts: `/api/auth/me`, `/api/oauth/userinfo`, `/api/internal/usernames/:username` (inbound). | `https://api.gothwadtech.com` — Accounts' Custom Domain. |
| `AUTH_SIGNIN_URL` | **Browser-facing links only**: `signinUrl` in a 401, and `accountUrl` in `/api/session`. | `https://accounts.gothwadtech.com` — the host people sign in on. |

Why two: Cloudflare does **not** invoke a same-zone Worker that is attached by a Route for a
server-to-server call. When Mail called `https://accounts.gothwadtech.com/api/auth/me`, the
request was served by the Pages SPA and answered `200 text/html`, so Mail had no session to
read and answered 503 `accounts_unexpected_response`. Server calls therefore use the Accounts
Custom Domain. Users still sign in on `accounts.gothwadtech.com`.

`AUTH_SIGNIN_URL` is optional: when it is unset it falls back to `AUTH_HUB_URL`. Both vars are
public config (`wrangler.toml` `[vars]`), not secrets.

## Identity and the email address

1. The browser calls `GET /api/session?meta=0` (identity). The Worker forwards the browser's
   cookies to Accounts: `GET {AUTH_HUB_URL}/api/auth/me`. That call is the ONLY thing the app
   waits for: no database work, no optional fields. Unread badges and the send quota come from
   a second, non-blocking request (`GET /api/session/meta`) — see `docs/STARTUP.md`.
2. If Accounts says `authenticated: true`, the Worker takes `user.username`. The address is
   **derived**: `username@APP_DOMAIN`. Accounts does not store the email.
3. If the user is not signed in, the Worker returns **401** with
   `signinUrl = {AUTH_SIGNIN_URL}/signin?choose=1`. The web app sends the browser there with
   `&next=` set to the Mail page. A one-time `__mail_auth_return=1` marker is included in
   that return URL so Mail can tell a failed SSO handoff from the initial sign-in.
4. Accounts can rotate the refresh token on `/auth/me`. It then sends new `gothwad_*`
   cookies. The Worker passes those cookies on to the browser. If it did not, the user would
   be signed out of Accounts everywhere.
5. Bearer tokens (`Authorization: Bearer ...`) are checked with
   `GET {AUTH_HUB_URL}/api/oauth/userinfo`. This is for future clients. The web app does not
   use it.
6. **A 401 from Mail may only ever mean "Accounts says this browser is signed out".** Any
   other answer Mail cannot read is a **503** with its own error code (table below), so a
   broken Accounts handoff can never be mistaken for a signed-out user and bounce the browser
   back to the chooser in a loop.
7. Upstream redirects are never followed (`redirect: 'manual'`). A 3xx from Accounts is an
   Accounts routing problem, reported as 503 `accounts_unexpected_response`.

#### `/api/session` status table

| What Accounts `GET /api/auth/me` answered | Mail `GET /api/session` (and `?meta=0`) |
| --- | --- |
| 401 / 403 (real signed-out) | 401 with `signinUrl` (unchanged) |
| 200, `authenticated: false` | 401 with `signinUrl` (unchanged) |
| 200, `authenticated: true`, usable `user.username` | 200 session (unchanged) |
| 200, `authenticated: true`, username missing or invalid | 503 `accounts_user_invalid` |
| 200, body is not Mail's JSON (e.g. HTML from a misrouted `/api/*`) or has no `authenticated` field | 503 `accounts_unexpected_response` |
| 3xx redirect from Accounts | 503 `accounts_unexpected_response` |
| network error, timeout, 5xx | 503 `auth_unavailable` (unchanged) |

Every failure above logs **one** `console.warn` line with the code, the upstream status and
the upstream content-type, for example
`accounts_check_failed code=accounts_unexpected_response status=200 content-type=text/html`.
Cookie values, tokens and response bodies are never logged.

The 503 `accounts_unexpected_response` body carries those same two values as `upstreamStatus`
and `upstreamContentType`, so the browser's DevTools shows "Accounts answered 200 text/html"
without opening the Worker log:

```json
{
  "error": "accounts_unexpected_response",
  "message": "Accounts did not answer with a session Mail can read. …",
  "upstreamStatus": 200,
  "upstreamContentType": "text/html; charset=utf-8"
}
```

Only the status and the content-type are included — never the upstream body, and never a
cookie or token value.

The web app only redirects to Accounts for a **401 with a `signinUrl`**. Every 503 shows the
error screen with a **Retry** button.

### If Accounts keeps showing the chooser

If the browser returns to Mail and immediately lands on Accounts' chooser again, the `next`
URL has already worked: Mail received the marked return URL, but `GET /api/session` still
could not verify the Accounts session. Mail stops after that return and shows a message
instead of sending the browser through an endless chooser loop.

Check the status and the `error` code of `https://mail.gothwadtech.com/api/session` in the
browser's Network panel (only the status code and the `error` field — never paste a body that
may contain tokens):

- **401 `unauthenticated`** — Mail received no valid shared Accounts session cookie. Check
  only that the `gothwad_at` and `gothwad_rt` cookies exist and their **Domain** is
  `.APP_DOMAIN`, Path is `/`, and Secure is enabled. Never paste cookie values into chat.
- **503 `accounts_user_invalid`** — the user IS signed in, but the Accounts profile row has no
  username Mail can use.
- **503 `accounts_unexpected_response`** — `/api/*` on Mail's `AUTH_HUB_URL` is not reaching
  the Accounts Worker, or Accounts is redirecting. Read `upstreamStatus` and
  `upstreamContentType`: `200 text/html` means the request hit the Pages SPA instead of the
  Worker (the classic same-zone Route problem), so `AUTH_HUB_URL` must be
  `https://api.gothwadtech.com`.
- **503 `auth_unavailable`** — the Accounts Worker is down or `AUTH_HUB_URL` is wrong.

## The mailbox model (Cloudflare D1)

Two tables in the `mail` D1 database. The Worker creates them itself on the first request
(`worker/src/db.ts`, idempotent `CREATE ... IF NOT EXISTS` in one `batch()`), so a brand-new
empty D1 database works with **zero manual SQL**. `sql/01_mail_schema.sql` documents the same
schema for humans; `sql/00_d1_console_bootstrap.sql` is the comment-free copy for the D1
console.

### `mail_settings` — one row per mailbox

| Column | Meaning |
| --- | --- |
| `username` | Lowercase username (primary key). Never a full address. |
| `retention_limit` | `500` (default), `1500`, or `0` = "Store All". |
| `quota_bytes` | Fair-use cap, default `52428800` (50 MB of **compressed** mail). |
| `updated_at` | ISO timestamp of the last change. |

### `mail_messages` — one row per message

Key columns:

- `id` (`crypto.randomUUID()`), `to_username` (mailbox owner), `from_email`, `from_name`,
  `to_email`.
- `cc_emails`, `bcc_emails`, `attachments` are **JSON strings** (SQLite has no arrays).
  Attachments are metadata only: `[{name, type, size}]`; bytes are never stored.
- `body_gzip` — **one gzip BLOB** holding JSON `{ "t": text, "h": html }`. HTML mail
  compresses ~5–8x, so ~12 KB of HTML becomes ~2 KB in D1. `body_text` / `body_html` stay in
  the schema as a fallback for rows written before compression.
- `size_bytes` — the real stored footprint (compressed body + metadata), so per-user usage is
  one cheap `SUM(size_bytes)`.
- `folder` (`inbox` / `sent` / `drafts` / `trash`), `is_read` (0/1), `is_starred` (0/1),
  `provider_id`, `received_at`.
- Indexes: `(to_username, folder, received_at DESC)` for folders and pagination, and a partial
  index `(to_username, is_starred, received_at DESC) WHERE is_starred = 1` for the Starred
  view and for retention's "starred is immune" checks.

Rules:

- **Every query filters on `to_username`** taken from the verified session. One user cannot
  read another user's row (a test proves Bob's message is a 404 for Alice).
- Sent mail is stored in the sender's mailbox with `folder = 'sent'`.
- "Starred" is a filter (`is_starred = 1` across `inbox` + `sent`), not a folder.
- **No PRAGMA** in runtime SQL: remote D1 already enables `foreign_keys` and rejects PRAGMA
  with `SQLITE_AUTH`.
- Bodies are capped **before** compression (100,000 text chars, 250,000 HTML chars) so no row
  can approach D1's 2 MB row limit.

## Retention and storage (why the mailbox stays small)

D1's free tier is 500 MB **shared by every mailbox**. Without a cap, one spam-flooded account
could fill it and break mail for everyone. So `worker/src/retention.ts` runs four rules after
every inbound message, after every send, and immediately when the user changes the setting:

| Rule | What it does |
| --- | --- |
| **A. 30-day Trash purge** | Deletes `folder = 'trash'` rows older than 30 days. |
| **B. Starred & Drafts immunity** | Automatic cleanup **never** deletes `is_starred = 1` rows or `drafts`. Ever. |
| **C. Count cap** (`retention_limit > 0`) | Keeps the newest N unstarred inbox/sent messages; older overflow is deleted in one indexed SQL statement. |
| **D. Fair-use quota** (`retention_limit = 0`, "Store All") | Keeps everything until the mailbox exceeds `quota_bytes` (50 MB compressed ≈ ~25,000 emails). Then it deletes the oldest unstarred **trash** first, then the oldest unstarred mail, until the mailbox is back under quota. |

Users choose 500 / 1,500 / Store All in **Settings → Mailbox Storage & Email Retention**,
which also shows a live progress bar (`Used X of 50 MB · N emails · K starred`).

Staff-visible effect: a mailbox can never grow without a bound, and an important starred email
is never removed by the system.

## API

All JSON. Everything except `/api/health` needs a signed-in session.

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/health` | Liveness, no auth. Reports `engine: "cloudflare-d1-native"`, `database: { bound, ready, tables }` (live query on `sqlite_master`) and `configured` booleans (`d1Binding`, `accountsInternalToken`, `resendApiKey`). Never prints a key or a URL. |
| GET | `/api/session?meta=0` | **Identity only** (what the app boots with): `{ authenticated, user { username, email, name, firstName, lastName, avatarUrl }, authuser, activeId, accounts[], accountUrl, accountsWebOrigin, meta: false, unread: null, limits: null }`. No D1 access at all. |
| GET | `/api/session/meta` | **Deferred metadata**: `{ authenticated, meta: true, authuser, unread: { username: count } \| null, limits { dailySendLimit, sendRemainingToday: number \| null } }`. `null` means "not known", never a zero. Reaching D1 here cannot delay the shell. |
| GET | `/api/session` | Combined response, kept for existing consumers: identity + `meta: true`, `unread`, `limits`. The web app no longer uses it on boot. |
| GET | `/api/mail/settings` | `{ retentionLimit, storageUsedBytes, storageQuotaBytes, totalMessages, starredMessages }`. |
| PATCH | `/api/mail/settings` | Body: `{ retentionLimit: 500 \| 1500 \| 0 }`. Saves, runs retention immediately, returns the updated stats plus `cleanup: { trashPurged, trimmed }`. |
| GET | `/api/mail/messages?folder=inbox\|starred\|sent\|drafts\|trash&limit=&before=` | One page, newest first (max 100). Returns `nextBefore` for "Load more". |
| GET | `/api/mail/messages/:id` | One message with its decompressed body. Sends an `ETag` and answers **304** to a matching `If-None-Match`, so re-opening a seen mail skips the gzip work and the download. |
| PATCH | `/api/mail/messages/:id` | Body: `{ isRead?, isStarred?, moveToTrash? }`. |
| DELETE | `/api/mail/messages/:id` | Permanent delete. Only for items already in Trash. |
| POST | `/api/mail/drafts` | Create or update a draft: `{ id?, to, cc, bcc, subject, body }`. |
| DELETE | `/api/mail/drafts/:id` | Delete a draft. |
| GET | `/api/mail/accounts` | Signed-in accounts for the switcher: `{ activeId, accounts[], unread{} }`. Empty + `unsupported: true` when Accounts has no multi-account API yet. |
| POST | `/api/mail/accounts/switch` | `{ id }` → makes that account the active one. 409 `account_not_signed_in` if Accounts no longer has a session for it. |
| POST | `/api/mail/accounts/signout` | `{ id }` → signs one account out; the active account moves to the next one, or the browser is signed out. |
| POST | `/api/mail/accounts/signout-all` | Signs every slot out (`Accounts /auth/signout`). The next `/api/session` answers 401, which is the one place that decides where the browser goes. |
| GET | `/api/mail/accounts/add` | 302 to Accounts' sign-in in append mode (`?choose=1&add=1`). |
| POST | `/api/mail/send` | Send: `{ to, cc?, bcc?, subject, body, draftId? }`. Returns 201 with `id`, `saved`, `remainingToday`. |

Errors use one shape: `{ error, message }`. Malformed ids return 400, not found returns 404,
and internal details are never shown outside development. A D1 failure returns 503
`db_unavailable` (or 503 `db_not_configured` when the `DB` binding is missing).

### Write requests (CSRF)

A write (POST/PATCH/DELETE) that uses cookies must:
- come from an **allowed origin** (`MAIL_URL`, plus `ALLOWED_ORIGINS` if set). Otherwise **403**.
- send `Content-Type: application/json`. Otherwise **415**.

Bearer-token requests skip the origin check, because they do not use cookies.

## Multiple accounts (Google-style switcher)

Mail shows one mailbox per request, but the browser can hold several *signed-in* accounts.
Accounts owns that list (one session per account slot plus an active pointer); Mail mirrors it
for the UI.

```
browser ──/api/mail/accounts────────► Mail Worker ──cookie──► Accounts /api/auth/accounts
        ◄─ accounts + unread counts ─┤        ◄─ rotated Set-Cookie ─┘
        ──/api/mail/accounts/switch──► (POST) ─────────────────► Accounts /api/auth/switch
```

Why a proxy instead of calling Accounts from the browser: no CORS, no third-party cookies, and
the "401 means signed out" rule stays in one place (`worker/src/accounts.ts`).

* **Unread per account** comes from Mail's D1 (`folder='inbox' AND is_read=0`), grouped in one
  query — and only for usernames Accounts just confirmed, so it cannot be used to count
  another mailbox.
* **Emails are derived** (`username@APP_DOMAIN`), never taken from the upstream body.
* **Switching clears every cache** before the next paint, and `App.tsx` keys `MailProvider` by
  slot id, so a remount is guaranteed. Showing one account's inbox to another would be a
  privacy leak, not just stale data.
* **No reload**: switch → `/api/session` re-read → the provider remounts and the new inbox loads
  (skeletons, then rows).
* **Before Accounts ships the feature** its endpoint 404s, Mail returns `unsupported: true`, and
  the sheet falls back to the single-account card. Deploying Mail first is safe.
* **Add another account** is a normal navigation to
  `{AUTH_SIGNIN_URL}/signin?choose=1&add=1&next=…`; the URL is built from config, never from the
  request, so it cannot become an open redirect.
* Keyboard: `Shift+A` opens the menu from anywhere; the avatar shows a `+n` bubble when more
  accounts are signed in.

### The menu itself is Accounts' widget, not Mail's UI

Every Gothwad app must show the *same* sheet, the way Gmail, Keep and Play show Google's
OneGoogle bar. Accounts hosts it once at
`${accountsWebOrigin}/widget/account-menu.js` (`window.GothwadAccountMenu`), and Mail consumes it:

* `src/services/accountWidget.ts` — the loader. It imports the module once (dynamic
  `import(/* @vite-ignore */ url)`, which is CORS-fetched; Accounts serves `/widget/*` with
  `Access-Control-Allow-Origin: *`), caches it, and **preloads it during idle time right after the
  session boots**, so the first avatar tap opens the sheet with no network wait. Failures resolve
  to a result object instead of throwing.
* `src/services/accountMenu.ts` — a pure mapping from Mail's state to the widget's
  `open(state, opts)`: user, accounts (with real `avatarUrl`), `activeId`, `authuser`, `theme`,
  unread `badges`, `accountHref(acct) → /u/<n>/` (so Ctrl/Cmd/middle-click opens that mailbox in
  a new tab), `nextUrl`, `manageAccountHref`, and the handlers.
* `src/components/AccountSheet.tsx` — the host. It opens the widget on the anchor element that
  was tapped, pushes `update()` while the sheet is open (new mail → new pills, theme toggle → new
  palette), and keeps React state in sync when the widget closes itself.
* Switching, sign-out, draft flushing and cache purging stay in **Mail's** handlers. The widget
  never talks to Mail's API; it calls the callbacks it was given.
* `accountsWebOrigin` comes from `/api/session`, so no domain is hardcoded in the browser bundle.
  In production it is the Worker's configured `AUTH_SIGNIN_URL`; in development it is the host the
  browser actually used, and the client then loads the plain path `/widget/account-menu.js`, which
  the Vite dev server proxies to the local stand-in. Same code path, no if-branches in the UI.
* If the script cannot load (offline, blocked host, Accounts redeploying), the avatar is **not**
  dead: `src/components/AccountSheetFallback.tsx` renders a compact in-app sheet with the same
  rows. It exists only for that case and is covered by tests, but it must never become the
  default.

The full contract for the Accounts side lives in [`ACCOUNTS_AGENT_PROMPT.md`](./ACCOUNTS_AGENT_PROMPT.md);
the plan and acceptance tests are in [`MULTI_ACCOUNT_PLAN.md`](./MULTI_ACCOUNT_PLAN.md).

### One account per tab: the URL is the state

Gmail's trick, copied exactly: the account lives in the **path**, the folder in the **hash**.

```
/u/0/          /u/1/#sent      /u/2/#drafts
mail/u/1/  →   /u/1/           (alias, rewritten on boot)
/?authuser=1 → /u/1/#inbox     (alias: the Gmail post-sign-in URL)
/?folder=starred → /u/0/#starred
```

* `normalizeAuthUserUrl()` runs once on boot: it reads the index from path or query, clamps it
  to 0..5, and rewrites the address bar with `replaceState` (no history entry). Query params
  that are not part of routing (`compose=1`, `__mail_auth_return=1`) ride along, so a one-shot
  action is never eaten by the rewrite.
* `writeFolderToUrl()` only touches the hash, so moving between Inbox and Sent never changes
  the account.
* `navigateToAccount()` pushes `/u/<n>/#<folder>` and a `popstate` listener treats Back/Forward
  as an account switch, so browser navigation behaves like the switcher.
* Every API call spreads `authUserHeaders()` → `X-Gothwad-Authuser: <n>`. The Worker validates
  it and forwards it to Accounts as the tab selector, so **two tabs of the same browser**, one
  cookie jar, two different mailboxes. Reading a slot never rotates another tab's session.
* `MailProvider` is keyed by the slot id, and mailbox caches are per slot
  (`src/services/mailboxCache.ts`). A switch therefore mounts an empty tree for the new account
  and paints its cached list second: a row of account A cannot survive into account B's frame.
  The UI test asserts this frame by frame.
* Switching is optimistic: draft flush → URL + session update (cached mailbox, <16 ms) →
  `POST /api/mail/accounts/switch` in the background. A `409` means that slot was revoked
  elsewhere; the tab is sent to `reauthUrl` for exactly that account instead of being signed out.
* Deep links need the host to serve `index.html`: `public/_redirects` (`/u/*` and `/mail/u/*`,
  200) for Pages, `appType: 'spa'` for the dev server. Assets are root-relative everywhere, so
  `/u/1/` loads them — `tests/assets.test.ts` walks the HTML and fails on a relative `src`.

### Local testing of the switcher

`tools/dev-server.mjs` runs a two-account Accounts stub (alice + bob) where the active slot is
the `gothwad_active` cookie, and serves `tools/account-menu-widget.stub.js` at
`/widget/account-menu.js` with the same `open/update/close/isOpen` API as the real widget. So
`npm run preview:api` + `npm run dev` shows the widget path end to end, and `npm run test:ui`
drives the same widget inside jsdom (the test installs the stand-in as
`window.GothwadAccountMenu`, which is what the loader checks first).

## Frontend

### Speed: what makes it feel instant

1. **Folder memory cache** (`src/context/MailContext.tsx`). Switching back to a folder
   paints the last list immediately, then revalidates in the background (a thin blue bar, no
   spinner, no layout jump). A failed revalidation keeps the cached list rather than showing
   an empty inbox.
2. **Detail memory cache + prefetch.** Hovering (desktop) or touching (mobile) a row warms
   the message body, so the tap usually opens instantly.
3. **Conditional GET (ETag/304).** The Worker tags a message with
   `"m-<id>-<read>-<starred>-<size>-<received_at>"`, built from cheap columns only. A repeat
   request that sends `If-None-Match` gets `304` and **no decompression, no body**.
   `Cache-Control: private, no-cache` keeps it per-user and always revalidated.
4. **List responses carry no bodies.** Opening a message is the only call that decompresses
   gzip, which is why the list stays cheap in D1.
5. **Code splitting.** `ComposeModal` and `SettingsModal` are `React.lazy` chunks
   (~8 KB each) mounted only when opened. First paint ships the inbox only.
6. **No API caching in the service worker.** Mail is private; the SW caches the app shell and
   fonts only, and `/api/*` is excluded (`navigateFallbackDenylist`).

### Layout and PWA

- The shell uses `100dvh` (not `100vh`) and flex `min-h-0` everywhere, so mobile browser
  chrome never hides the composer or the bottom bar.
- Bottom navigation is 5 folders with an unread badge, a round compose button, and
  `env(safe-area-inset-bottom)` padding for iPhone home-bar devices.
- Skeletons replace spinners for the list and the message body.
- `public/manifest.json` has `display_override`, `orientation`, `categories` and three
  shortcuts (`/?compose=1`, `/?folder=inbox`, `/?folder=starred`); the app reads those params
  once and then clears them from the URL.
- The tab title shows the unread inbox count: `(3) Gothwad Mail`.
- Reduced-motion and iOS 16px input rules live in `src/index.css`.

### Settings

- `src/services/mailApi.ts` has `getSettings()` and `updateSettings(limit)`.
- `src/context/MailContext.tsx` loads usage when the Settings panel opens and refreshes the
  message list after a retention change (messages may have been trimmed).
- `src/components/SettingsModal.tsx` shows the storage bar, the three retention choices and the
  reassurance badge: "⭐ Starred emails & Drafts are never auto-deleted. Trash empties after
  30 days."

## Sending

1. Validate: recipients (max 25), subject, body (max 100,000 characters). Strip and check
   the addresses.
2. If no outbound provider is configured, return **503 `sending_not_configured`**. The provider
   is pluggable (`worker/src/send/`, chosen by `MAIL_SEND_PROVIDER`) — see
   [SENDING.md](SENDING.md).
3. Check the daily cap: sent rows today for this user, against `DAILY_SEND_LIMIT` (default
   30). Over the cap returns **429**.
4. Send from `username@APP_DOMAIN` through the configured provider. A provider rate limit is
   **429** `provider_rate_limited`; an unreachable or rejecting provider is **502**
   `send_failed`.
5. Insert a copy in `sent` (gzip body + `size_bytes`). If that insert fails, the response
   still says the mail was sent (`saved: false`) and the failure is logged.
6. If a `draftId` was given, delete that draft.
7. Run retention for the sender's mailbox.

## Drafts and autosave

- The compose window saves a draft about **2 seconds** after you stop typing (debounced).
- One save runs at a time, so a fast typist does not create duplicate drafts.
- An empty compose window deletes the draft it made earlier.
- Discarding a compose window deletes its draft.
- Opening a draft from the Drafts folder loads the full draft into compose.

## Inbound

The `email()` handler runs for each message that Email Routing sends to the Worker.

1. Reject if the recipient is not on `APP_DOMAIN` (**550**). Case-insensitive.
2. Reject if the raw message is over `MAX_INBOUND_BYTES` (default 10 MB) (**552**), before any
   parsing or database call.
3. **Accounts-only:** the name must be a real Gothwad user. After validating its shape, the
   Worker sends the lowercased local part to
   `GET {AUTH_HUB_URL}/api/internal/usernames/:username` with
   `Authorization: Bearer <ACCOUNTS_INTERNAL_TOKEN>` (same value as Accounts'
   `MAIL_INTERNAL_TOKEN`). True → continue; false → **550**. Bad shape → **550** with no
   network call. Missing token, network/timeout failure, non-200 response (including 401), or
   invalid JSON → **451** (sender retries). The Worker never guesses that a name exists and
   never reads Accounts' database.
4. Parse MIME with `postal-mime`.
5. Truncate text to 100,000 chars and HTML to 250,000 chars, gzip them into `body_gzip`, and
   compute `size_bytes`.
6. Attachments: **metadata only** (`name`, `type`, `size`). Bytes are dropped. The reader says
   so.
7. Insert `folder = 'inbox'`, `to_username` = lowercase local part, then run retention.

## The reader is safe by design

Email HTML is untrusted. The reader renders it in an `<iframe srcdoc>` with:
- `sandbox` **without** `allow-scripts` and without `allow-same-origin`. Scripts do not run,
  and the frame cannot touch the app or its cookies.
- A CSP meta tag: `default-src 'none'`, so only images, styles and fonts are allowed.

The Worker also returns the raw HTML. The iframe is the protection, not the server.

## Limits (defaults)

| What | Default | Config |
| --- | --- | --- |
| Sends per user per UTC day | 30 | `DAILY_SEND_LIMIT` (free plan: keep 20–50) |
| Inbound size | 10 MB | `MAX_INBOUND_BYTES` |
| Recipients per message | 25 | code (`MAX_RECIPIENTS`) |
| List page size | 50 in the app, max 100 in the API | code |
| Stored text / HTML | 100,000 / 250,000 chars (before gzip) | code |
| Retention | 500 / 1,500 / Store All | `mail_settings.retention_limit` |
| Per-mailbox quota | 50 MB compressed (~25k mails) | `mail_settings.quota_bytes` |
| Trash | auto-purged after 30 days | code (`TRASH_RETENTION_DAYS`) |
| Attachments kept | metadata only | see `PLAN.md` |

## Local testing with real SQLite

`tools/local-d1.mjs` wraps Node 22's built-in `node:sqlite` (`DatabaseSync`) as a
`D1Database`-shaped object. Tests therefore run **real** SQLite (CHECK constraints, indexes,
BLOBs) with zero NPM packages and no database mock. `tools/dev-server.mjs` runs the real Worker
against that adapter and fakes only Resend + Accounts, so the full UI can be previewed
locally.

## Why some choices were made

- **No service key at all**: D1 is reached through the Worker's `DB` binding, so there is no
  database credential to leak.
- **Gzip bodies**: 5–8x smaller rows is what makes ~250,000 mails fit in the free 500 MB D1.
- **`size_bytes` per row**: usage (`SUM`) and quota enforcement stay O(1)-ish, no scanning of
  bodies.
- **Auto-bootstrap schema**: a fresh D1 database works on the first request, and a deploy
  never needs a manual SQL step.
- **Retention inline**: a mailbox is never left oversized waiting for a cron job; the free
  tier has no always-on scheduler.
- **No polling**: manual refresh is enough and keeps the free tier quiet.
- **Derived email**: Accounts does not store the email, so the address is always
  `username@APP_DOMAIN`, computed in one place.
