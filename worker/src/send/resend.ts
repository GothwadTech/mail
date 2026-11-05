// =============================================================================
// Outbound mail through Resend (free tier: 3,000 emails/month, 100/day).
//
// The Resend API key lives ONLY in the Worker (wrangler secret). The browser
// never talks to Resend. The From address must be on a domain you verified
// in Resend (see docs/SETUP.md).
//
// This adapter is one of several: `send/index.ts` picks it when the key is the
// configured provider, so switching providers never touches the route.
// =============================================================================

import { HttpError } from '../http';
import type { OutboundMail } from './types';

const RESEND_URL = 'https://api.resend.com/emails';

export async function sendViaResend(apiKey: string, mail: OutboundMail): Promise<string> {
  const payload: Record<string, unknown> = {
    from: mail.from,
    to: mail.to,
    subject: mail.subject || '(no subject)',
    text: mail.text,
    html: mail.html,
  };
  if (mail.cc.length) payload.cc = mail.cc;
  if (mail.bcc.length) payload.bcc = mail.bcc;

  let res: Response;
  try {
    res = await fetch(RESEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new HttpError(502, 'send_failed', 'Could not reach the mail provider. Please try again.');
  }

  if (!res.ok) {
    // Log the status only. The body can contain account hints, so keep it out of logs.
    console.error('resend_error', res.status);
    if (res.status === 429) {
      throw new HttpError(429, 'provider_rate_limited', 'Mail provider is busy. Please try again later.');
    }
    throw new HttpError(502, 'send_failed', 'The mail provider rejected this message.');
  }

  const body = (await res.json().catch(() => null)) as { id?: string } | null;
  return body?.id ?? '';
}
