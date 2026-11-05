// =============================================================================
// Outbound mail through Cloudflare Email Sending (the `send_email` binding).
//
// Optional, and OFF unless it is configured: Cloudflare Email Sending requires
// the Workers Paid plan for arbitrary recipients, and it is still a beta, so the
// owner decides when to switch. Nothing here runs unless
// `MAIL_SEND_PROVIDER = "cloudflare"` (or the binding is the only one present).
//
// The binding is not a network call the Worker can abort, so no timeout is set;
// it resolves quickly or throws, and both outcomes are mapped to Mail's own
// error codes so the UI keeps the same messages as the Resend path.
// =============================================================================

import type { EmailBinding } from '../config';
import { HttpError } from '../http';
import type { OutboundMail } from './types';

export async function sendViaCloudflare(binding: EmailBinding, mail: OutboundMail): Promise<string> {
  const message: Record<string, unknown> = {
    from: mail.from,
    to: mail.to,
    subject: mail.subject || '(no subject)',
    text: mail.text,
    html: mail.html,
  };
  if (mail.cc.length) message.cc = mail.cc;
  if (mail.bcc.length) message.bcc = mail.bcc;

  try {
    const result = await binding.send(message);
    return result?.messageId ?? '';
  } catch (err) {
    const code = (err as { code?: string } | null)?.code ?? 'unknown';
    // Codes, never the message: it can echo an address back.
    console.error('cloudflare_send_error', code);
    if (code === 'E_RATE_LIMIT_EXCEEDED' || code === 'E_DAILY_LIMIT_EXCEEDED') {
      throw new HttpError(429, 'provider_rate_limited', 'Mail provider is busy. Please try again later.');
    }
    throw new HttpError(502, 'send_failed', 'The mail provider rejected this message.');
  }
}
