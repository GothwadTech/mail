# Sending: which provider puts the mail on the wire

Mail stores, reads and searches its own mail in D1, but **delivering** an outbound message needs
something on the public internet that speaks SMTP. This document says what that takes, what Mail
already abstracts, and how to change providers without touching the app.

## What sending actually requires

| # | Requirement | Who provides it today |
| --- | --- | --- |
| 1 | An SMTP relay/server that delivers the message | Resend (a vendor) |
| 2 | Domain authentication in DNS: SPF + DKIM + DMARC | `APP_DOMAIN`'s zone (the owner's Cloudflare DNS) |
| 3 | Sending IP reputation, blocklist monitoring, bounce feedback | The vendor's shared IPs |

A Cloudflare Worker **cannot** be its own SMTP server: the Workers runtime refuses outbound
connections on port 25 to prevent abuse, so every design needs a relay somewhere. That is why
"independent of every provider" and "independent of one provider" are different goals.

## What Mail abstracts

`worker/src/send/` is a small adapter layer, and `worker/src/index.ts` (the send route) only
knows about two things: build an `OutboundMail`, hand it over.

| File | Job |
| --- | --- |
| `send/types.ts` | `OutboundMail` — the one message shape every adapter accepts |
| `send/resend.ts` | Resend's REST API (10 s timeout, 429 → `provider_rate_limited`, other failures → 502) |
| `send/cloudflare.ts` | Cloudflare Email Sending through the `send_email` binding (same error mapping) |
| `send/index.ts` | Picks the configured provider; throws Mail's own 503 when none is ready |

Everything around the provider stays identical: recipient/subject/body validation, the
`DAILY_SEND_LIMIT` cap (checked **before** any provider is called), the gzip Sent copy with the
provider id, draft cleanup and retention. The browser never sees a provider key.

### Choosing a provider

| `MAIL_SEND_PROVIDER` | Needs | Result |
| --- | --- | --- |
| unset | — | Auto: `RESEND_API_KEY` first, then the `EMAIL` binding, else 503 |
| `resend` | `RESEND_API_KEY` secret | Sends through `api.resend.com` |
| `cloudflare` | `[[send_email]]` binding named `EMAIL` | Sends through Cloudflare Email Sending |
| anything else | — | **503 `sending_not_configured`** and a logged `send_provider_unknown` |

An explicitly named provider that is missing its credential is a hard 503, never a quiet
fallback to another vendor: a half-finished deploy must not send through an account the owner
did not choose.

`GET /api/health` reports the outcome as `send: { provider: "resend" | "cloudflare" | null }`
plus `configured.emailBinding` (booleans only — never a key, never a prefix).

## Option 1: Resend (current default, free)

* Free plan: 3,000 emails/month with a **100/day** cap, one verified sending domain.
* Setup: verify `APP_DOMAIN` in Resend (it prints SPF/DKIM records to add), then
  `npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml`.
* Nothing to change in code. This is what the deployment uses today.

## Option 2: Cloudflare Email Sending (same vendor as hosting)

Optional, and **not enabled** in `wrangler.toml`. Current Cloudflare terms (checked 2026-11):

* Public beta since 2026-04; sending to arbitrary recipients requires the **Workers Paid** plan
  ($5/month). The free plan can only send to verified destination addresses.
* 3,000 outbound emails/month included, then $0.35 per 1,000; message limit 25 MiB, 50
  recipients across to/cc/bcc; brand-new accounts start with a conservative daily quota.
* Methods: Workers binding, REST API, or authenticated SMTP (`smtp.mx.cloudflare.net:465`).

Steps to switch later:

1. Workers Paid plan active; onboard `APP_DOMAIN` under **Email Service → Email Sending** in the
   dashboard (Cloudflare writes the SPF/DKIM/DMARC records itself).
2. Uncomment the binding in `worker/wrangler.toml`:
   ```toml
   [[send_email]]
   name = "EMAIL"
   ```
3. Set `MAIL_SEND_PROVIDER = "cloudflare"` in `[vars]`, deploy the Worker.
4. Check `GET /api/health` → `send.provider` must read `"cloudflare"`, then send one test mail.
5. Keep `RESEND_API_KEY` in place for a while: switching back is one variable, not a rewrite.

Because it is a beta on a paid plan, it is documented here as a choice, not a recommendation.

## Option 3: your own mail server

Possible, and the only way to own delivery end to end — but it is infrastructure work, not a
code change: a VPS with a static IP, the host allowing outbound port 25, a PTR/rDNS record
matching the server name, a full stack (Postfix/Mailcow/Maddy), a 2048-bit DKIM key, SPF, DMARC
reporting, blocklist monitoring and an IP warm-up that can take weeks. New IPs land in spam
until they build reputation, so for a mailbox that sends a few dozen mails a day the effort is
almost never worth it.

If it is ever done, Mail only needs a new adapter in `worker/src/send/` — the route, the quota
and the Sent copy stay untouched.

## DNS records every option needs

| Record | Purpose |
| --- | --- |
| SPF (`TXT` on the apex, or `v=spf1 include:… -all`) | Lists who may send for the domain |
| DKIM (`TXT` at `<selector>._domainkey`) | Signs each message; the provider prints the value |
| DMARC (`TXT` at `_dmarc`) | Tells receivers what to do on failure; start `p=none`, tighten later |

Only one SPF record may exist per domain — if another app already sends from `APP_DOMAIN`,
extend that record instead of adding a second one.

## Known gap

Bounces and complaints are not processed yet: there is no webhook or queue consumer, so a
message that fails after acceptance is only visible in the provider's dashboard. Adding it is
provider-specific and is the natural next step for deliverability, not a requirement for this
adapter.
