// =============================================================================
// One outbound message, in the shape every provider adapter accepts.
//
// The Worker does not care which company puts this on the wire: the send handler
// builds this object once, and `send/index.ts` hands it to the configured
// provider. Adding a provider means adding one file here, not editing the route.
// =============================================================================

/** Exactly what goes out. Addresses are already validated by the route. */
export interface OutboundMail {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string;
}

/** The providers this Worker knows how to talk to. */
export type SendProviderName = 'resend' | 'cloudflare';

/** What the route needs back: a provider id worth storing with the Sent copy. */
export interface SendOutcome {
  provider: SendProviderName;
  /** Provider's own message id, or '' when it did not return one. */
  providerId: string;
}
