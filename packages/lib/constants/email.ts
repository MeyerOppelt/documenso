import { match } from 'ts-pattern';

import type { TEmailTransportConfig } from '../server-only/email/email-transport-config';
import { env } from '../utils/env';

export const FROM_ADDRESS = env('NEXT_PRIVATE_SMTP_FROM_ADDRESS') || 'noreply@documenso.com';
export const FROM_NAME = env('NEXT_PRIVATE_SMTP_FROM_NAME') || 'Documenso';

/**
 * Bytes allowed for MIME headers and part boundaries when measuring a completion email
 * against the transport's message size limit.
 *
 * This is a safety margin, not a measurement. Headers and boundaries on a two-part
 * multipart message are small and bounded, and rendering them just to count them is not
 * worth the cost, so we allow generously and err towards dropping an attachment that
 * would have fit rather than sending one that does not.
 */
export const MIME_OVERHEAD_ALLOWANCE = 8 * 1024;

/**
 * Operator override for the max rendered message size of completion emails, in bytes.
 *
 * - `null`  — unset or unparseable: fall back to the per-transport default.
 * - `0`     — never attach; completion emails always go out as a download link only. This is an
 *             instance-wide kill switch and overrides the per-envelope `attachCompletedDocument`
 *             setting, since an admin who sets it has said their transport cannot carry PDFs.
 * - `n > 0` — attach while the whole rendered message fits, otherwise fall back to a link.
 */
export const MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE = (): number | null => {
  const rawMaxAttachmentSize = env('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE');

  // Empty-string is treated as unset — `Number('')` is `0`, which would otherwise collapse
  // "no cap" into "never attach" for anyone with a bare `FOO=` in their environment.
  if (rawMaxAttachmentSize === undefined || rawMaxAttachmentSize.trim() === '') {
    return null;
  }

  const maxAttachmentSize = Number(rawMaxAttachmentSize);

  if (!Number.isFinite(maxAttachmentSize)) {
    return null;
  }

  return Math.max(0, maxAttachmentSize);
};

/**
 * The effective max rendered message size for completion emails sent over a given transport.
 *
 * `NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE` wins for every transport when it is set. With it
 * unset the limit comes from the transport itself:
 *
 * - `MAILCHANNELS` — `0`. The MailChannels transport builds its payload from the rendered
 *   bodies alone and never reads `mail.data.attachments`, so fetching PDFs for it is waste.
 * - `RESEND` — 40 MB, Resend's documented whole-message limit (base64-encoded attachments
 *   included).
 * - `SMTP_API` / `SMTP_AUTH` — `null`. The limit belongs to the operator's server and is not
 *   knowable from here, so guessing it would silently strip attachments from self-hosters
 *   whose server happily carried them yesterday.
 *
 * Transport is resolved per organisation, so this is a per-send value. Do not cache it at
 * module scope.
 */
export const resolveMaxCompletedDocumentAttachmentSize = (
  transportType: TEmailTransportConfig['type'],
): number | null => {
  const configuredMaxAttachmentSize = MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE();

  if (configuredMaxAttachmentSize !== null) {
    return configuredMaxAttachmentSize;
  }

  return match(transportType)
    .with('MAILCHANNELS', () => 0)
    .with('RESEND', () => 40_000_000)
    .with('SMTP_API', 'SMTP_AUTH', () => null)
    .exhaustive();
};

export const DOCUMENSO_INTERNAL_EMAIL = {
  name: FROM_NAME,
  address: FROM_ADDRESS,
};

export const EMAIL_VERIFICATION_STATE = {
  NOT_FOUND: 'NOT_FOUND',
  VERIFIED: 'VERIFIED',
  EXPIRED: 'EXPIRED',
  ALREADY_VERIFIED: 'ALREADY_VERIFIED',
} as const;

export const USER_SIGNUP_VERIFICATION_TOKEN_IDENTIFIER = 'confirmation-email';
