// =============================================================================
// Which provider actually sends the mail.
//
// Mail is deliberately not married to one vendor. The route asks for "a way to
// send this message"; this module answers with the configured adapter:
//
//   MAIL_SEND_PROVIDER = "resend"      -> Resend API  (needs RESEND_API_KEY)
//   MAIL_SEND_PROVIDER = "cloudflare"  -> send_email binding (needs EMAIL)
//   unset                              -> auto: Resend key first, then the
//                                         Cloudflare binding, else "not set up"
//
// An explicitly named provider that is not configured is a hard 503, never a
// silent fallback: a half-configured deploy must not send through some other
// company's account behind the owner's back.
// =============================================================================

import type { Env } from '../config';
import { HttpError } from '../http';
import { sendViaCloudflare } from './cloudflare';
import { sendViaResend } from './resend';
import type { OutboundMail, SendOutcome, SendProviderName } from './types';

export type { OutboundMail, SendProviderName } from './types';

const KNOWN: readonly SendProviderName[] = ['resend', 'cloudflare'];

/** The provider this deployment can actually use, or null when none is ready. */
export function configuredSendProvider(env: Env): SendProviderName | null {
  const explicit = (env.MAIL_SEND_PROVIDER ?? '').trim().toLowerCase();

  if (explicit) {
    if (!KNOWN.includes(explicit as SendProviderName)) {
      // A typo must be visible in health, not silently ignored.
      console.error('send_provider_unknown', explicit.slice(0, 20));
      return null;
    }
    if (explicit === 'resend') return env.RESEND_API_KEY?.trim() ? 'resend' : null;
    return env.EMAIL ? 'cloudflare' : null;
  }

  // Unset: keep the historical default (Resend) so nothing changes for the
  // deployment that already works, then fall back to the binding.
  if (env.RESEND_API_KEY?.trim()) return 'resend';
  if (env.EMAIL) return 'cloudflare';
  return null;
}

/** Throws Mail's own 503 when no provider is configured. */
export function requireSendProvider(env: Env): SendProviderName {
  const provider = configuredSendProvider(env);
  if (provider) return provider;
  throw new HttpError(
    503,
    'sending_not_configured',
    'Sending is not set up yet. Ask the admin to configure a mail provider.'
  );
}

/** Sends one message through the configured provider. */
export async function sendMail(env: Env, provider: SendProviderName, mail: OutboundMail): Promise<SendOutcome> {
  if (provider === 'cloudflare') {
    if (!env.EMAIL) requireSendProvider(env);
    const providerId = await sendViaCloudflare(env.EMAIL as NonNullable<Env['EMAIL']>, mail);
    return { provider, providerId };
  }
  const key = env.RESEND_API_KEY?.trim();
  if (!key) requireSendProvider(env);
  const providerId = await sendViaResend(key as string, mail);
  return { provider, providerId };
}
