import type { DocumentMeta } from '@prisma/client';
import { DocumentDistributionMethod } from '@prisma/client';
import { z } from 'zod';

export enum DocumentEmailEvents {
  RecipientSigningRequest = 'recipientSigningRequest',
  RecipientRemoved = 'recipientRemoved',
  RecipientSigned = 'recipientSigned',
  DocumentPending = 'documentPending',
  DocumentCompleted = 'documentCompleted',
  /**
   * Not an email event — there is no email called `attachCompletedDocument`. This is an
   * option that modifies the document completed emails rather than suppressing them. It
   * lives on this enum because the enum is what drives the checkbox `id`/`htmlFor` pairs
   * and the `hiddenEvents` machinery in `document-email-checkboxes.tsx`, and a parallel
   * mechanism for a single key is not worth the duplication.
   */
  AttachCompletedDocument = 'attachCompletedDocument',
  DocumentDeleted = 'documentDeleted',
  OwnerDocumentCompleted = 'ownerDocumentCompleted',
  OwnerRecipientExpired = 'ownerRecipientExpired',
  OwnerDocumentCreated = 'ownerDocumentCreated',
}

export const ZDocumentEmailSettingsSchema = z
  .object({
    recipientSigningRequest: z
      .boolean()
      .describe('Whether to send an email to all recipients that the document is ready for them to sign.')
      .default(true),
    recipientRemoved: z
      .boolean()
      .describe('Whether to send an email to the recipient who was removed from a pending document.')
      .default(true),
    recipientSigned: z
      .boolean()
      .describe('Whether to send an email to the document owner when a recipient has signed the document.')
      .default(true),
    documentPending: z
      .boolean()
      .describe(
        'Whether to send an email to the recipient who has just signed the document indicating that there are still other recipients who need to sign the document. This will only be sent if the document is still pending after the recipient has signed.',
      )
      .default(true),
    documentCompleted: z
      .boolean()
      .describe('Whether to send an email to all recipients when the document is complete.')
      .default(true),
    attachCompletedDocument: z
      .boolean()
      .describe(
        'Whether to attach the completed document to the document completed emails. When disabled, the emails contain a download link instead of the PDF attachment.',
      )
      .default(true),
    documentDeleted: z
      .boolean()
      .describe('Whether to send an email to all recipients if a pending document has been deleted.')
      .default(true),
    ownerDocumentCompleted: z
      .boolean()
      .describe('Whether to send an email to the document owner when the document is complete.')
      .default(true),
    ownerRecipientExpired: z
      .boolean()
      .describe("Whether to send an email to the document owner when a recipient's signing window has expired.")
      .default(true),
    ownerDocumentCreated: z
      .boolean()
      .describe('Whether to send an email to the document owner when a document is created from a direct template.')
      .default(true),
  })
  .strip()
  .catch(() => ({ ...DEFAULT_DOCUMENT_EMAIL_SETTINGS }));

export type TDocumentEmailSettings = z.infer<typeof ZDocumentEmailSettingsSchema>;

export const extractDerivedDocumentEmailSettings = (documentMeta?: DocumentMeta | null): TDocumentEmailSettings => {
  const emailSettings = ZDocumentEmailSettingsSchema.parse(documentMeta?.emailSettings ?? {});

  if (!documentMeta?.distributionMethod || documentMeta?.distributionMethod === DocumentDistributionMethod.EMAIL) {
    return emailSettings;
  }

  return {
    recipientSigningRequest: false,
    recipientRemoved: false,
    recipientSigned: false,
    documentPending: false,
    documentCompleted: false,
    documentDeleted: false,
    // The owner completion email still sends under a non-email distribution method, so the
    // attachment preference is still meaningful here and must be preserved rather than forced.
    attachCompletedDocument: emailSettings.attachCompletedDocument,
    ownerDocumentCompleted: emailSettings.ownerDocumentCompleted,
    ownerRecipientExpired: emailSettings.ownerRecipientExpired,
    ownerDocumentCreated: emailSettings.ownerDocumentCreated,
  };
};

export const DEFAULT_DOCUMENT_EMAIL_SETTINGS: TDocumentEmailSettings = {
  recipientSigningRequest: true,
  recipientRemoved: true,
  recipientSigned: true,
  documentPending: true,
  documentCompleted: true,
  attachCompletedDocument: true,
  documentDeleted: true,
  ownerDocumentCompleted: true,
  ownerRecipientExpired: true,
  ownerDocumentCreated: true,
};
