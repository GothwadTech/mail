// Health: public readiness probe, no upstream calls.
//
// Split out of worker.test.ts so no test file grows past a few hundred
// lines; the harness in helpers.ts is shared. Run: npm run test:worker

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handleRequest } from '../src/index.ts';
import { textToHtml, cleanRecipients } from '../src/mail.ts';
import { localPartForDomain } from '../src/inbound.ts';
import { Db } from '../src/db.ts';
import {
  h,
  MAIL_ORIGIN,
  req,
  authed,
  writeInit,
  seedMessage,
  countRows,
  fullStub,
  accountsStub,
  accountsMeStub,
  hubOnlyStub,
  sessionResponse,
  inboundMessage,
  makeEnv,
  ACCOUNTS_TOKEN,
  RESEND_KEY,
  parsePatch,
  type Seen,
  type Stub,
  type Env,
} from './helpers.ts';

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('health is public, reports D1 readiness, and calls no upstream', async () => {
  const res = await worker.fetch(req('/api/health'), h.env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.engine, 'cloudflare-d1-native');
  assert.equal(body.service, 'gothwad-mail');
  assert.deepEqual(body.database, { bound: true, ready: true, tables: 2 });
  assert.deepEqual(body.configured, {
    d1Binding: true,
    accountsInternalToken: true,
    resendApiKey: true,
    emailBinding: false,
  });
  assert.equal(h.seen.length, 0, 'health must not call upstreams');
});

test('health with no D1 binding says bound:false and never leaks values', async () => {
  const res = await worker.fetch(req('/api/health'), { ENVIRONMENT: 'production' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.database, { bound: false, ready: false, tables: 0 });
  assert.deepEqual(body.configured, {
    d1Binding: false,
    accountsInternalToken: false,
    resendApiKey: false,
    emailBinding: false,
  });
  assert.equal(body.send.provider, null, 'no provider configured is reported as null');
  const text = JSON.stringify(body);
  assert.equal(text.toLowerCase().includes('supabase'), false, 'zero Supabase fields remain');
  assert.equal(text.includes('re_'), false, 'never prints a key');
});

test('health bootstraps a brand-new empty D1 database on the very first request', async () => {
  const res = await worker.fetch(req('/api/health'), h.env);
  const body = await res.json();
  assert.equal(body.database.ready, true);
  assert.equal(body.database.tables, 2);
});
