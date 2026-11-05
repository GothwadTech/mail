# Setup — steps for a human

These are the steps only a person can do: dashboards, DNS, routing and secrets. An agent must
not run them, and must not ask for live keys in chat.

Gothwad Mail is **100% Cloudflare native**: Workers + D1. There is no Supabase project, no
database URL and no database key to paste anywhere. Replace placeholders like `YOUR_DOMAIN`
and `re_...` with your own values.

---

## 0. Pick your values

| Name | Example | Where it lives |
| --- | --- | --- |
| `APP_DOMAIN` | `gothwadtech.com` | `wrangler.toml` `[vars]` (public) |
| `AUTH_HUB_URL` | `https://api.gothwadtech.com` | `wrangler.toml` `[vars]` (public) |
| `AUTH_SIGNIN_URL` | `https://accounts.gothwadtech.com` | `wrangler.toml` `[vars]` (public) |
| `MAIL_URL` | `https://mail.gothwadtech.com` | `wrangler.toml` `[vars]` (public) |
| D1 database | `mail` (binding `DB`) | `wrangler.toml` `[[d1_databases]]` (public) |
| `ACCOUNTS_INTERNAL_TOKEN` | Same value as Accounts' `MAIL_INTERNAL_TOKEN` | **secret** |
| `RESEND_API_KEY` | `re_...` | **secret** |

`AUTH_HUB_URL` is the base for **every server-side Accounts call** (`/api/auth/me`,
`/api/oauth/userinfo`, `/api/internal/usernames/:username`), so it must be a host that reaches
the Accounts Worker: its **Custom Domain** `https://api.gothwadtech.com`. Cloudflare does not
invoke a same-zone Worker behind a Route for a server-to-server call, so
`https://accounts.gothwadtech.com` answers the Pages SPA HTML there and Mail reports 503
`accounts_unexpected_response`. `AUTH_SIGNIN_URL` is used only for browser-facing links (the
sign-in redirect and `accountUrl`); it is optional and falls back to `AUTH_HUB_URL`.

The domain, URLs and the D1 database id are not secrets. The two Worker secrets are. Set them
with `wrangler secret put` or in the Cloudflare dashboard, never in `wrangler.toml` or git. Do
not paste the token into chat. The token value must match on the Accounts and Mail Workers.

---

## 1. Cloudflare D1: the `mail` database

The database already exists. Its id is committed in `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "mail"
database_id = "87854cea-7feb-46f3-ab99-2a2137f31105"
```

To confirm it in the dashboard:

1. Cloudflare dashboard → **Storage & Databases → D1 SQL Database**.
2. Open **`mail`**, copy the **Database ID** if you ever need to replace the file value.
3. Optionally open **Console** and paste **`sql/00_d1_console_bootstrap.sql`** (comment-free).
   This is **not required**: the Worker creates the tables itself on the first request. It is
   handy when you want to see the schema before deploying.

Schema notes:

- `mail_settings` = one row per mailbox (retention + quota).
- `mail_messages` = the mailbox. Bodies are gzip BLOBs (`body_gzip`); attachments are metadata
  only.
- **Never add `PRAGMA` statements** to D1 SQL. Remote D1 already enables `foreign_keys` and
  rejects PRAGMA with `SQLITE_AUTH`.
- `.github`-style migrations are not needed: `worker/src/db.ts` runs idempotent
  `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` in one `batch()` per isolate.

If you ever recreate the database, update `database_id` here **and** in `wrangler.toml`.
`npm run test:config` fails if the id is a placeholder or the binding is wrong.

---

## 2. Worker secrets

Only two secrets exist on Worker `mail`:

1. **`ACCOUNTS_INTERNAL_TOKEN`** — must equal `MAIL_INTERNAL_TOKEN` on the `accounts` Worker.
2. **`RESEND_API_KEY`** — from Resend (free plan: 3,000 emails/month, 100/day).

Sending is provider-neutral: `MAIL_SEND_PROVIDER` (`resend` | `cloudflare`) picks the adapter in
`worker/src/send/`, and `GET /api/health` reports the active one as `send.provider`. Cloudflare
Email Sending needs the Workers Paid plan and is not enabled here. Every option, plus the SPF /
DKIM / DMARC records any provider needs, is in [SENDING.md](SENDING.md).

Set both from your machine (Wrangler prompts for each value; nothing is echoed):

```bash
npm run worker:secrets
```

Or in the dashboard: **Workers & Pages → `mail` → Settings → Variables and Secrets →
Production → Add → type Secret**.

List only the secret *names* (safe to paste):

```bash
npm run worker:secrets:list
```

Expected: `ACCOUNTS_INTERNAL_TOKEN`, `RESEND_API_KEY`.

`SUPABASE_SERVICE_ROLE_KEY` is gone. If the deployed Worker still shows it, delete it in the
dashboard (leftover only; the code no longer reads it).

### Local secrets (never committed)

```bash
cp worker/.dev.vars.example worker/.dev.vars
```

`worker/.dev.vars` is git-ignored. For a plain browser preview you do not even need real
secrets — see section 6.

---

## 3. Accounts: register the OAuth client (optional for cookie SSO)

The cookie SSO flow needs nothing in Accounts beyond the shared internal token. The
`gothwad-mail` OAuth client is only needed for a future code flow, and those callbacks are:

- `https://mail.gothwadtech.com/auth/callback`
- `https://mail.gothwadtech.com/oauth/callback`

Accounts v2 stores this in its own D1 (`ecosystem_apps`). A human may review and run the
Accounts-side SQL; an agent must not run it. Never point Mail at the Accounts database.

---

## 4. Deploy the Worker

```bash
npm run worker:deploy
```

Verify:

```bash
curl -s https://mail.gothwadtech.com/api/health
```

Expected shape (booleans and counts only — no keys, no values):

```json
{
  "ok": true,
  "service": "gothwad-mail",
  "engine": "cloudflare-d1-native",
  "environment": "production",
  "database": { "bound": true, "ready": true, "tables": 2 },
  "configured": { "d1Binding": true, "accountsInternalToken": true, "resendApiKey": true }
}
```

- `database.ready: false` → the `DB` binding is missing or D1 answered an error. Check
  `[[d1_databases]]` and the dashboard D1 status.
- `configured.*: false` → that secret/var is missing on the deployed Worker.

### Route and Email Routing (dashboard)

1. **Workers & Pages → `mail` → Settings → Domains & Routes**: keep the route
   `mail.gothwadtech.com/api/*` → `mail`.
2. **Email Routing → Routes → Catch-all**: send `*@YOUR_DOMAIN` to Worker `mail`.
3. Keep Email Routing off until the Accounts username endpoint is confirmed working.

The Worker name must stay **`mail`**. Workers Builds overrides the config name with
`WRANGLER_CI_OVERRIDE_NAME`, so a mismatch still deploys from Git but makes local
`wrangler` commands target the wrong Worker. Fix the file, never the dashboard.

### Why `previews = {}` is in `worker/wrangler.toml`

Workers Builds runs `npx wrangler deploy` on the production branch, but
`npx wrangler preview` on **every other branch** (pull requests). `wrangler preview` refuses to
start without a `previews` block, so every PR showed a failed **Workers Builds: mail** check
while `main` stayed green. The block is intentionally **empty**: a Preview only gets the
bindings listed inside it, so a branch build has **no D1 database and no secrets** and can
never read or trim production mail. Production deploys ignore the block.

**If the PR check is still red after this block exists**, the dashboard's Preview command is
not seeing this config. `worker/wrangler.toml` is not at the repo root, and the default
`npx wrangler preview` looks for `wrangler.toml` in the directory it runs in. One-time
dashboard fix (owner only):

> Workers & Pages → `mail` → **Settings → Builds** → **Previews** tab
> → **Preview command**: `npx wrangler preview --config worker/wrangler.toml`
> → **Root directory**: `/` (keep it at the repo root)

### Do not change the Production Root directory

Both build commands rely on the repo root:

| Setting | Value (Production **and** Previews) | Why |
| --- | --- | --- |
| Root directory | `/` | `package.json`, `node_modules` and the `worker/` folder live here. |
| Build command | `npm ci` | Installs from the root `package.json`. |
| Deploy command (Production) | `npm run worker:deploy` | Runs `wrangler deploy --config worker/wrangler.toml`; that path is relative to the root. |
| Preview command (Previews) | `npx wrangler preview --config worker/wrangler.toml` | Same reason: the config lives in `worker/`. |

Setting **Root directory = `worker`** looks tempting, but it breaks production: `npm ci` would
have no `package.json`, and `--config worker/wrangler.toml` would resolve to
`worker/worker/wrangler.toml`. Keep the root at `/` and pass `--config` instead.

This was already red on the previously merged PR #7, so it is a repo setting, not a code
problem: the production branch (`main`) runs `npx wrangler deploy` and stays green.

Want real preview data later? Create a **separate** D1 database (e.g. `mail-preview`) and add
its binding under `[previews]`. Never point previews at `mail`.

---

## 5. Retention: what the owner should know

Every mailbox has a retention setting, changeable in the app at
**Settings → Mailbox Storage & Email Retention**:

| Choice | Effect |
| --- | --- |
| **Latest 500 emails** (default) | Keeps the newest 500 unstarred inbox/sent messages. |
| **Latest 1,500 emails** | Same, with a larger cap. |
| **Store All Emails** | Keeps everything until the mailbox reaches the 50 MB fair-use quota. |

Non-negotiable safety rules:

- **Starred emails and Drafts are never auto-deleted.**
- **Trash empties after 30 days.**
- When "Store All" exceeds 50 MB, the oldest unstarred **trash** goes first, then the oldest
  unstarred mail, until the mailbox is back under quota.

Why the quota exists: the free D1 database is 500 MB **shared by all mailboxes**. 50 MB of
compressed mail is roughly 25,000 messages per user, and it stops one spam-flooded account
from using up everyone's storage.

To inspect a mailbox in the dashboard console (read-only):

```sql
SELECT COUNT(*) AS messages, COALESCE(SUM(size_bytes), 0) AS used_bytes
FROM mail_messages WHERE to_username = 'someone';

SELECT username, retention_limit, quota_bytes, updated_at FROM mail_settings;
```

---

## 6. Local development

```bash
npm install
cp .env.example .env.local                      # public settings only
cp worker/.dev.vars.example worker/.dev.vars    # local-only values

# Option A — full preview, real SQLite, no Accounts/Resend needed:
npm run preview:api      # Worker + local D1 on http://127.0.0.1:8787
npm run dev              # web app on http://localhost:3000 (proxies /api)

# Option B — Wrangler's own local D1:
npm run worker:dev
npm run dev
```

`preview:api` (`tools/dev-server.mjs`) runs the real Worker against `node:sqlite` through
`tools/local-d1.mjs`, seeds a small local mailbox, fakes Resend, and fakes Accounts only for
cookie-based requests. Requests without any cookie use `DEV_AUTH_USERNAME`, so the browser
preview opens straight into the inbox. Nothing leaves your machine.

### Checks

```bash
npm run lint          # web app + Worker typecheck
npm run test:config   # wrangler.toml guard (D1 binding, no secrets, no Supabase)
npm run test:auth     # sign-in return URL logic
npm run test:worker   # 57 Worker tests against real SQLite
npm run test:d1       # 15 D1/compression/retention tests
npm run test:ui       # jsdom UI smoke test (needs preview:api or worker:dev running)
npm run build
npx wrangler deploy --config worker/wrangler.toml --dry-run
```

`npm test` runs all of the above except the build and the dry-run.

---

## 7. Removing the old Supabase project (one-time, human)

After the D1 version is live and verified:

1. Confirm `https://mail.gothwadtech.com/api/health` has **no** Supabase field and shows
   `engine: cloudflare-d1-native`.
2. In the Supabase dashboard, review and delete the old **Mail** project (never the Accounts
   project).
3. In Cloudflare, delete any leftover `SUPABASE_*` variable or secret on Worker `mail`.
4. Remove `SUPABASE_*` from your local `.env.local` / `worker/.dev.vars`.
5. Old mail that lived only in Supabase is not migrated automatically. If you need it, export
   it from Supabase **before** deleting the project, then re-import with a small script.

---

## 8. Final checklist

- [ ] D1 database `mail` exists; `wrangler.toml` has binding `DB`, `database_name = "mail"`,
      and the real UUID `87854cea-7feb-46f3-ab99-2a2137f31105`
- [ ] Worker `mail` has exactly two secrets: `ACCOUNTS_INTERNAL_TOKEN`, `RESEND_API_KEY`
- [ ] `ACCOUNTS_INTERNAL_TOKEN` equals Accounts' `MAIL_INTERNAL_TOKEN`
- [ ] `AUTH_HUB_URL = https://api.gothwadtech.com`, `AUTH_SIGNIN_URL = https://accounts.gothwadtech.com`
- [ ] `GET /api/health` → `database.ready: true`, all three `configured` booleans `true`
- [ ] Route `mail.gothwadtech.com/api/*` → Worker `mail`
- [ ] Email Routing catch-all `*@YOUR_DOMAIN` → Worker `mail`
- [ ] Sign in, open a message, send a test mail (Sent copy appears)
- [ ] Settings → change retention to 1,500, see the storage bar update
- [ ] Old Supabase project deleted, `SUPABASE_*` vars removed
