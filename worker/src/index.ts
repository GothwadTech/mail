// =============================================================================
// Gothwad Mail Worker: one Worker with two entry points.
//
//   fetch()  -> REST API under /api/* (route: mail.gothwadtech.com/api/*)
//   email()  -> inbound mail from Cloudflare Email Routing (catch-all)
//
// Storage is Cloudflare D1 (`env.DB`, database `mail`). Zero Supabase.
//
// Endpoints (all JSON, all need a signed-in Accounts session except /api/health):
//   GET    /api/health                     (public: D1 readiness + config booleans)
//   GET    /api/session                    identity + metadata (unchanged shape)
//   GET    /api/session?meta=0             identity only: what the app boots on
//   GET    /api/session/meta               unread + quota (deferred, non-blocking)
//   GET    /api/mail/settings              storage + retention
//   PATCH  /api/mail/settings              { retentionLimit: 500 | 1500 | 0 }
//   GET    /api/mail/messages?folder=inbox|starred|sent|drafts|trash&limit=&before=
//   GET    /api/mail/messages/:id
//   PATCH  /api/mail/messages/:id          { isRead?, isStarred?, moveToTrash? }
//   DELETE /api/mail/messages/:id          only for items already in Trash
//   POST   /api/mail/drafts                { id?, to, cc, bcc, subject, body }
//   DELETE /api/mail/drafts/:id
//   POST   /api/mail/send                  { to, cc?, bcc?, subject, body, draftId? }
//   GET    /api/mail/accounts              signed-in accounts + per-account unread
//   POST   /api/mail/accounts/switch        { id } -> switch the active account
//   POST   /api/mail/accounts/signout       { id } -> sign one account out
//   POST   /api/mail/accounts/signout-all          -> sign every account out
//   GET    /api/mail/accounts/add          302 to Accounts sign-in in append mode
// =============================================================================

import { readConfig, configStatus, type Config, type Env } from './config';
import { Db } from './db';
import { corsHeaders, errorResponse, HttpError, json, assertSafeWrite, readJson } from './http';
import * as mail from './mail';
import { addAccountResponse, listAccounts, signOutAccount, signOutAllAccounts, switchAccount } from './accounts';
import { authUserFromRequest } from './authuser';
import {
  fullPayload,
  identityPayload,
  loadSessionMeta,
} from './sessionPayload';
import { handleInbound } from './inbound';
import {
  enforceRetention,
  getSettings,
  isRetentionLimit,
  mailboxStats,
  updateRetentionLimit,
} from './retention';
import { resolveSession, signinBaseUrl, deriveEmail, takeUpstreamCookies, type Session } from './session';
import { configuredSendProvider, requireSendProvider, sendMail } from './send';

async function requireSession(request: Request, config: Config): Promise<Session> {
  const session = await resolveSession(request, config);
  if (!session) {
    // 401 means ONLY "Accounts says this browser is signed out". The browser
    // uses signinUrl to send the user to Accounts (then back to Mail).
    // Every other failure throws its own 503 from session.ts, so a broken
    // Accounts answer can never look like a signed-out user.
    throw new HttpError(401, 'unauthenticated', 'Please sign in.', { signinUrl: signinBaseUrl(config) });
  }
  return session;
}

/** Settings + live usage in one response, so the UI needs a single call. */
async function settingsPayload(env: Env, username: string) {
  const db = await Db.from(env);
  const settings = await getSettings(db, username);
  const stats = await mailboxStats(db, username, settings.quotaBytes);
  return {
    retentionLimit: settings.retentionLimit,
    storageQuotaBytes: stats.storageQuotaBytes,
    storageUsedBytes: stats.storageUsedBytes,
    totalMessages: stats.totalMessages,
    starredMessages: stats.starredMessages,
    updatedAt: settings.updatedAt,
  };
}

/**
 * GET /api/session
 *
 * Two halves on purpose:
 *   `?meta=0` -> identity only (one Accounts call, no D1). This is what the app
 *                boots with, so a slow database cannot delay the shell.
 *   default   -> identity + unread + quota in a single response. Kept for
 *                existing consumers and for anyone wanting one round trip.
 */
async function handleSession(request: Request, env: Env, config: Config, url: URL): Promise<Response> {
  const session = await requireSession(request, config);

  if (url.searchParams.get('meta') === '0') {
    return json(identityPayload(request, config, session));
  }

  const meta = await loadSessionMeta(env, config, session);
  return json(fullPayload(request, config, session, meta));
}

/**
 * GET /api/session/meta
 *
 * The deferred half: unread badges for the accounts Accounts just confirmed,
 * plus the send quota. It re-verifies with Accounts (one call, same rule as
 * every other route) and never redirects anything by itself: the browser only
 * faces a sign-in redirect from the identity call.
 */
async function handleSessionMeta(request: Request, env: Env, config: Config): Promise<Response> {
  const session = await requireSession(request, config);
  const meta = await loadSessionMeta(env, config, session);
  return json({ authenticated: true, meta: true, ...meta });
}

async function handleSend(request: Request, env: Env, config: Config, session: Session): Promise<Response> {
  assertSafeWrite(request, config);
  const body = await readJson<Record<string, unknown>>(request, 512 * 1024);

  const to = mail.cleanRecipients(body.to, 'to');
  if (to.length === 0) throw new HttpError(400, 'no_recipients', 'Add at least one recipient.');
  const cc = mail.cleanRecipients(body.cc, 'cc');
  const bcc = mail.cleanRecipients(body.bcc, 'bcc');
  mail.checkRecipientCount(to, cc, bcc);
  const subject = mail.cleanSubject(body.subject);
  const text = mail.cleanBody(body.body);
  const draftId = body.draftId ? mail.parseId(String(body.draftId)) : null;

  // Fail clearly when no provider is ready yet (see docs/SETUP.md). The
  // provider is pluggable: Resend or Cloudflare Email Sending, chosen by config.
  const provider = requireSendProvider(env);

  const db = await Db.from(env);
  const sentToday = await mail.countSentToday(db, session.username);
  if (sentToday >= config.dailySendLimit) {
    throw new HttpError(429, 'daily_limit', `Daily send limit reached (${config.dailySendLimit} per day).`, {
      limit: config.dailySendLimit,
      remaining: 0,
    });
  }

  const from = deriveEmail(session.username, config.appDomain);
  const html = mail.textToHtml(text);
  const { providerId } = await sendMail(env, provider, {
    from,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
  });

  // The mail has left at this point. If saving the copy fails, we still tell
  // the user it was sent, and log the failure (no body content in logs).
  let savedId: string | null = null;
  try {
    const stored = await mail.insertMessage(db, {
      username: session.username,
      folder: 'sent',
      fromEmail: from,
      fromName: session.name,
      to,
      cc,
      bcc,
      subject,
      text,
      html,
      isRead: true,
      providerId: providerId || null,
    });
    savedId = stored.id;
  } catch {
    console.error('sent_copy_not_saved');
  }

  if (draftId) {
    try {
      await mail.deleteDraft(db, session.username, draftId);
    } catch {
      console.error('draft_cleanup_failed');
    }
  }

  // Keep the mailbox inside its retention cap right away.
  try {
    await enforceRetention(db, session.username);
  } catch {
    console.error('send_retention_failed');
  }

  return json(
    {
      id: savedId,
      sent: true,
      saved: savedId !== null,
      remainingToday: Math.max(config.dailySendLimit - sentToday - 1, 0),
      // Which adapter delivered it. Useful when a deploy changes providers.
      provider,
    },
    201
  );
}

/** Live D1 readiness for /api/health. Never throws: a broken DB is a status. */
async function d1Readiness(env: Env): Promise<{ bound: boolean; ready: boolean; tables: number }> {
  if (!env.DB) return { bound: false, ready: false, tables: 0 };
  try {
    const db = await Db.from(env);
    const row = await db.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('mail_messages', 'mail_settings')"
    );
    const tables = Number(row?.n ?? 0);
    return { bound: true, ready: tables === 2, tables };
  } catch {
    return { bound: true, ready: false, tables: 0 };
  }
}

async function route(request: Request, env: Env, config: Config): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (!path.startsWith('/api/')) {
    return json({ error: 'not_found' }, 404);
  }

  if (path === '/api/health' && method === 'GET') {
    // Booleans and counts only: lets a human confirm after a deploy that the
    // D1 binding works and no secret was wiped, without ever printing a key.
    const database = await d1Readiness(env);
    return json({
      ok: true,
      service: 'gothwad-mail',
      engine: 'cloudflare-d1-native',
      environment: config.isProduction ? 'production' : 'development',
      database,
      configured: configStatus(env, config),
      // Which outbound provider would send right now ("resend" | "cloudflare"),
      // or null when nothing is configured. A name, never a credential.
      send: { provider: configuredSendProvider(env) },
    });
  }

  if (path === '/api/session' && method === 'GET') {
    return handleSession(request, env, config, url);
  }

  if (path === '/api/session/meta' && method === 'GET') {
    return handleSessionMeta(request, env, config);
  }

  if (path === '/api/mail/settings' && method === 'GET') {
    const session = await requireSession(request, config);
    return json(await settingsPayload(env, session.username));
  }

  if (path === '/api/mail/settings' && method === 'PATCH') {
    const session = await requireSession(request, config);
    assertSafeWrite(request, config);
    const body = await readJson<Record<string, unknown>>(request);
    if (!isRetentionLimit(body.retentionLimit)) {
      throw new HttpError(400, 'bad_retention_limit', 'retentionLimit must be 500, 1500 or 0 (store all).');
    }

    const db = await Db.from(env);
    await updateRetentionLimit(db, session.username, body.retentionLimit);
    // Lowering the limit must take effect immediately, not at the next inbound
    // mail. Starred messages and drafts are never touched (see retention.ts).
    const cleanup = await enforceRetention(db, session.username);

    return json({ ...(await settingsPayload(env, session.username)), cleanup });
  }

  if (path === '/api/mail/messages' && method === 'GET') {
    const session = await requireSession(request, config);
    const opts = mail.parseListOptions(url);
    const db = await Db.from(env);
    const messages = await mail.listMessages(db, session.username, opts);
    return json({
      messages,
      folder: opts.folder,
      nextBefore: messages.length === opts.limit ? messages[messages.length - 1].receivedAt : null,
    });
  }

  if (path === '/api/mail/send' && method === 'POST') {
    const session = await requireSession(request, config);
    return handleSend(request, env, config, session);
  }

  if (path === '/api/mail/drafts' && method === 'POST') {
    const session = await requireSession(request, config);
    assertSafeWrite(request, config);
    const draft = mail.parseDraft(await readJson(request, 512 * 1024));
    const message = await mail.saveDraft(
      await Db.from(env),
      session.username,
      session.email,
      session.name,
      draft
    );
    return json({ message });
  }

  // ----- Account switcher (see accounts.ts) --------------------------------
  // These routes deliberately do not call requireSession: the Accounts call they
  // make is itself the authentication check, and mapping its answer here keeps
  // the "401 only means signed out" rule in one place.
  if (path === '/api/mail/accounts' && method === 'GET') {
    // The tab's selector is forwarded, so the list reflects this tab's slot.
    return json(await listAccounts(env, request, config, authUserFromRequest(request)));
  }

  if (path === '/api/mail/accounts/switch' && method === 'POST') {
    assertSafeWrite(request, config);
    const body = await readJson<Record<string, unknown>>(request);
    return json(await switchAccount(env, request, config, body, authUserFromRequest(request)));
  }

  if (path === '/api/mail/accounts/signout' && method === 'POST') {
    assertSafeWrite(request, config);
    const body = await readJson<Record<string, unknown>>(request);
    return json(await signOutAccount(env, request, config, body, authUserFromRequest(request)));
  }

  if (path === '/api/mail/accounts/signout-all' && method === 'POST') {
    assertSafeWrite(request, config);
    return json(await signOutAllAccounts(request, config, authUserFromRequest(request)));
  }

  if (path === '/api/mail/accounts/add' && method === 'GET') {
    // A navigation: the signed-in session builds the link, and `?authuser=` from
    // the current tab decides which index the new account takes.
    const session = await requireSession(request, config);
    const requested = authUserFromRequest(request);
    const nextIndex = requested && /^\d$/.test(requested) ? Number(requested) + 1 : undefined;
    return addAccountResponse(config, session, nextIndex);
  }

  const idMatch = path.match(/^\/api\/mail\/(messages|drafts)\/([^/]+)$/);
  if (idMatch) {
    const [, kind, rawId] = idMatch;
    // decodeURIComponent throws on a bad % sequence (e.g. /%E0%A4%A). Turn that
    // into a clean 400 instead of letting it become a 500.
    let decodedId: string;
    try {
      decodedId = decodeURIComponent(rawId);
    } catch {
      throw new HttpError(400, 'bad_request', 'Malformed message id.');
    }
    const id = mail.parseId(decodedId);
    const session = await requireSession(request, config);

    if (kind === 'messages' && method === 'GET') {
      const db = await Db.from(env);
      // Cheap row first: if the browser already has this body, stop here and
      // skip the gzip decompression entirely (304, no body).
      const row = await mail.getMessageRow(db, session.username, id);
      const etag = mail.messageEtag(row);
      const cacheHeaders = { etag, 'cache-control': 'private, no-cache' };
      if (mail.etagMatches(request.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers: cacheHeaders });
      }
      return json({ message: await mail.toDetailDto(row) }, 200, cacheHeaders);
    }

    if (kind === 'messages' && method === 'PATCH') {
      assertSafeWrite(request, config);
      const patch = mail.parsePatch(await readJson(request));
      const message = await mail.patchMessage(await Db.from(env), session.username, id, patch);
      return json({ message });
    }

    if (kind === 'messages' && method === 'DELETE') {
      assertSafeWrite(request, config);
      await mail.deleteTrashed(await Db.from(env), session.username, id);
      return json({ ok: true });
    }

    if (kind === 'drafts' && method === 'DELETE') {
      assertSafeWrite(request, config);
      await mail.deleteDraft(await Db.from(env), session.username, id);
      return json({ ok: true });
    }
  }

  return json({ error: 'not_found' }, 404);
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const config = readConfig(env);
  const cors = corsHeaders(request.headers.get('origin'), config);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  let response: Response;
  try {
    response = await route(request, env, config);
  } catch (err) {
    response = errorResponse(err, config);
  }

  for (const [key, value] of Object.entries(cors)) {
    response.headers.set(key, value);
  }
  // Pass on any rotated Accounts cookies (see session.ts). Done after errors too.
  for (const cookie of takeUpstreamCookies(request)) {
    response.headers.append('set-cookie', cookie);
  }
  return response;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const config = readConfig(env);
    await handleInbound(message, config, env);
  },
} satisfies ExportedHandler<Env>;
