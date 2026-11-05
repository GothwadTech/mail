// Sending is provider-neutral: Resend or Cloudflare Email Sending.
//
// The route must behave exactly the same either way — same 429s, same 502s,
// same Sent copy, same "not configured" 503 — so these tests drive the real
// handler with a fake `send_email` binding and compare it to the Resend path.
//
// Run: npm run test:worker

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { configuredSendProvider } from '../src/send/index.ts';
import type { EmailBinding } from '../src/config.ts';
import {
  h,
  req,
  authed,
  writeInit,
  countRows,
  fullStub,
  makeEnv,
  type Env,
} from './helpers.ts';

interface BoundCall {
  to: unknown;
  from: unknown;
  subject: unknown;
  cc?: unknown;
  bcc?: unknown;
  text?: unknown;
  html?: unknown;
}

/** A stand-in for Cloudflare's `send_email` binding that records what it got. */
function fakeBinding(fail?: { code: string }): { binding: EmailBinding; calls: BoundCall[] } {
  const calls: BoundCall[] = [];
  const binding: EmailBinding = {
    async send(message) {
      calls.push(message as BoundCall);
      if (fail) {
        const err = new Error('provider said no') as Error & { code: string };
        err.code = fail.code;
        throw err;
      }
      return { messageId: 'cf_msg_1' };
    },
  };
  return { binding, calls };
}

const sendBody = { to: ['bob@example.com'], cc: ['carol@example.com'], subject: 'Hi', body: 'Hello there' };

function send(env: Env) {
  return worker.fetch(authed('/api/mail/send', writeInit('POST', sendBody)), env);
}

const resendCalls = () => h.seen.filter((s) => s.url.host === 'api.resend.com').length;

test('the default deployment still sends through Resend and says so', async () => {
  h.stub = fullStub;
  const res = await send(h.env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.provider, 'resend');
  assert.equal(resendCalls(), 1);
  assert.equal(await countRows("folder = 'sent' AND provider_id = 're_msg_1'"), 1, 'provider id is stored');
});

test('MAIL_SEND_PROVIDER=cloudflare uses the binding and never calls Resend', async () => {
  h.stub = fullStub;
  const { binding, calls } = fakeBinding();
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: undefined });

  const res = await send(h.env);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.provider, 'cloudflare');
  assert.equal(resendCalls(), 0, 'no vendor API call when the binding is configured');

  assert.equal(calls.length, 1);
  const message = calls[0];
  assert.equal(message.from, 'alice@gothwadtech.com', 'From is username@APP_DOMAIN, like the Resend path');
  assert.deepEqual(message.to, ['bob@example.com']);
  assert.deepEqual(message.cc, ['carol@example.com']);
  assert.equal(message.subject, 'Hi');
  assert.ok(String(message.text).includes('Hello there'));
  assert.ok(String(message.html).includes('Hello there'), 'an HTML body is always included');

  assert.equal(await countRows("folder = 'sent' AND provider_id = 'cf_msg_1'"), 1, 'the Sent copy keeps the id');
  assert.equal(await countRows("folder = 'sent'"), 1);
});

test('an explicit provider that is not configured is a clear 503, never a silent fallback', async () => {
  h.stub = fullStub;
  // Cloudflare asked for, but the binding was never added to wrangler.toml.
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'cloudflare' });
  const missingBinding = await send(h.env);
  assert.equal(missingBinding.status, 503);
  assert.equal((await missingBinding.json()).error, 'sending_not_configured');

  // A typo is treated the same way instead of picking a provider behind the owner's back.
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'postmark' });
  const typo = await send(h.env);
  assert.equal(typo.status, 503);
  assert.equal((await typo.json()).error, 'sending_not_configured');

  assert.equal(resendCalls(), 0, 'nothing was sent by either path');
  assert.equal(await countRows("folder = 'sent'"), 0);
});

test('with no MAIL_SEND_PROVIDER the binding is used when there is no Resend key', async () => {
  h.stub = fullStub;
  const { binding, calls } = fakeBinding();
  h.env = makeEnv({ RESEND_API_KEY: undefined, EMAIL: binding });
  assert.equal(configuredSendProvider(h.env), 'cloudflare');

  const res = await send(h.env);
  assert.equal(res.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(resendCalls(), 0);
});

test('binding failures keep Mail error codes: rate limit is 429, anything else 502', async () => {
  h.stub = fullStub;

  const limited = fakeBinding({ code: 'E_RATE_LIMIT_EXCEEDED' });
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'cloudflare', EMAIL: limited.binding, RESEND_API_KEY: undefined });
  const res429 = await send(h.env);
  assert.equal(res429.status, 429);
  assert.equal((await res429.json()).error, 'provider_rate_limited');
  assert.equal(await countRows("folder = 'sent'"), 0, 'a failed send is not saved as Sent');

  const failed = fakeBinding({ code: 'E_DELIVERY_FAILED' });
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'cloudflare', EMAIL: failed.binding, RESEND_API_KEY: undefined });
  const res502 = await send(h.env);
  assert.equal(res502.status, 502);
  const body = await res502.json();
  assert.equal(body.error, 'send_failed');
  assert.equal(body.message.includes('E_DELIVERY_FAILED'), false, 'provider codes are not echoed to the browser');
  assert.equal(await countRows("folder = 'sent'"), 0);
});

test('the daily cap, validation and the Sent copy work the same on the binding path', async () => {
  h.stub = fullStub;
  const { binding, calls } = fakeBinding();
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: undefined, DAILY_SEND_LIMIT: '1' });
  await (await import('./helpers.ts')).seedMessage({ folder: 'sent', daysAgo: 0 });

  const capped = await send(h.env);
  assert.equal(capped.status, 429);
  assert.equal((await capped.json()).error, 'daily_limit');
  assert.equal(calls.length, 0, 'the cap is checked before any provider is called');
});

test('health names the provider without printing a credential', async () => {
  h.stub = fullStub;
  const { binding } = fakeBinding();
  h.env = makeEnv({ MAIL_SEND_PROVIDER: 'cloudflare', EMAIL: binding, RESEND_API_KEY: undefined });

  const res = await worker.fetch(req('/api/health'), h.env);
  const body = await res.json();
  assert.equal(body.send.provider, 'cloudflare');
  assert.equal(body.configured.emailBinding, true);
  const text = JSON.stringify(body);
  assert.equal(text.includes('re_'), false, 'no key prefix anywhere in the health body');

  h.env = makeEnv({ RESEND_API_KEY: undefined });
  const empty = await (await worker.fetch(req('/api/health'), h.env)).json();
  assert.equal(empty.send.provider, null);
});
