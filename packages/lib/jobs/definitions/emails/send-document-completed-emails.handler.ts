import { DocumentCompletedEmailTemplate } from '@documenso/email/templates/document-completed';
import { prisma } from '@documenso/prisma';
import { msg } from '@lingui/core/macro';
import type { Recipient } from '@prisma/client';
import { DocumentSource, EnvelopeType, RecipientRole } from '@prisma/client';
import { createElement } from 'react';

import { getI18nInstance } from '../../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../../constants/app';
import { resolveMaxCompletedDocumentAttachmentSize } from '../../../constants/email';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { assertOrganisationRatesAndLimits } from '../../../server-only/rate-limit/assert-organisation-rates-and-limits';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import type { GetFileOptions } from '../../../universal/upload/get-file.server';
import { getFileServerSide, getFileSizeServerSide } from '../../../universal/upload/get-file.server';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import {
  getBase64EncodedSize,
  getUtf8ByteLength,
  shouldAttachCompletedDocuments,
} from '../../../utils/email-attachments';
import { renderCompletedEmailProbeSize } from '../../../utils/email-attachments-probe';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import { isRecipientEmailValidForSending } from '../../../utils/recipients';
import { renderCustomEmailTemplate } from '../../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../../utils/render-email-with-i18n';
import { formatDocumentsPath } from '../../../utils/teams';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendDocumentCompletedEmailsJobDefinition } from './send-document-completed-emails';

type CompletedDocumentEmailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

type CompletionEmailRecipient = Pick<Recipient, 'name' | 'email' | 'role' | 'token'>;

export const run = async ({ payload, io }: { payload: TSendDocumentCompletedEmailsJobDefinition; io: JobRunIO }) => {
  const { envelopeId, requestMetadata } = payload;

  const envelope = await prisma.envelope.findUnique({
    where: unsafeBuildEnvelopeIdQuery({ type: 'envelopeId', id: envelopeId }, EnvelopeType.DOCUMENT),
    include: {
      envelopeItems: {
        include: {
          documentData: {
            select: {
              type: true,
              id: true,
              data: true,
            },
          },
        },
      },
      documentMeta: true,
      recipients: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          disabled: true,
        },
      },
      team: {
        select: {
          id: true,
          url: true,
        },
      },
    },
  });

  if (!envelope) {
    throw new Error('Document not found');
  }

  const isDirectTemplate = envelope?.source === DocumentSource.TEMPLATE_DIRECT_LINK;

  if (envelope.recipients.length === 0) {
    throw new Error('Document has no recipients');
  }

  const {
    branding,
    emailLanguage,
    senderEmail,
    replyToEmail,
    organisationId,
    claims,
    emailsDisabled,
    emailTransport,
    emailTransportType,
  } = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  // Don't send completion emails if the organisation has email sending disabled or the owner is disabled (e.g. banned).
  if (envelope.user.disabled || emailsDisabled) {
    io.logger.warn({
      msg: 'Completion emails skipped: the envelope owner is disabled, or the organisation has email sending disabled',
      envelopeId: envelope.id,
      organisationId,
      isOwnerDisabled: envelope.user.disabled,
      emailsDisabled,
    });

    return;
  }

  const { user: owner } = envelope;

  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL() || 'http://localhost:3000';

  let documentOwnerDownloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}${formatDocumentsPath(
    envelope.team?.url,
  )}/${envelope.id}`;

  if (envelope.team?.url) {
    documentOwnerDownloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}/t/${envelope.team.url}/documents/${envelope.id}`;
  }

  const emailSettings = extractDerivedDocumentEmailSettings(envelope.documentMeta);
  const isDocumentCompletedEmailEnabled = emailSettings.documentCompleted;
  const isOwnerDocumentCompletedEmailEnabled = emailSettings.ownerDocumentCompleted;

  // Transport is resolved per organisation, so the effective cap is per-send rather than
  // per-deployment and must not be hoisted out of the handler.
  const maxMessageBytes = resolveMaxCompletedDocumentAttachmentSize(emailTransportType);

  // Building the attachments pulls every envelope item's full PDF out of storage, so only
  // pay for it when an email is actually going out with an attachment on it. A cap of `0`
  // is the kill switch and beats the per-envelope setting, so it has to short-circuit here
  // rather than after the fetch.
  const canBuildAttachments =
    emailSettings.attachCompletedDocument &&
    maxMessageBytes !== 0 &&
    (isDocumentCompletedEmailEnabled || isOwnerDocumentCompletedEmailEnabled);

  let completedDocumentEmailAttachments: CompletedDocumentEmailAttachment[] = [];
  let wasAttachmentDropped = false;

  if (canBuildAttachments) {
    let isWithinAttachmentLimit = true;

    // With no numeric cap there is nothing to compare against and nothing measured here
    // could change the decision, so the probe is skipped entirely and an uncapped
    // deployment makes no storage calls beyond the fetch it was already making.
    if (maxMessageBytes !== null) {
      const [renderedMessageBytes, totalRawBytes] = await Promise.all([
        renderCompletedEmailProbeSize({
          assetBaseUrl,
          branding,
          emailLanguage,
          downloadLink: getLongestCompletionDownloadLink(envelope.recipients, documentOwnerDownloadLink),
          customBody: getLongestCompletionCustomBody({
            recipients: envelope.recipients,
            documentName: envelope.title,
            message: isDirectTemplate ? envelope.documentMeta?.message : undefined,
          }),
          reportUrl: getCompletionReportUrl(envelope.recipients),
        }),
        resolveTotalEnvelopeItemBytes({
          envelopeId: envelope.id,
          documentDataList: envelope.envelopeItems.map((envelopeItem) => envelopeItem.documentData),
          io,
        }),
      ]);

      isWithinAttachmentLimit = shouldAttachCompletedDocuments({
        isAttachmentEnabled: emailSettings.attachCompletedDocument,
        // An unresolved size is unknown, not free — under a cap that has to mean "drop".
        encodedAttachmentBytes: totalRawBytes === null ? Infinity : getBase64EncodedSize(totalRawBytes),
        renderedMessageBytes,
        maxMessageBytes,
      });

      if (!isWithinAttachmentLimit) {
        // Dropping the attachment beats a hard send failure — the recipients are still
        // notified and the email's download link still resolves to the sealed document.
        wasAttachmentDropped = true;

        io.logger.warn({
          msg: 'Completion email attachments dropped: the rendered message exceeds the transport limit',
          envelopeId: envelope.id,
          totalRawBytes,
          renderedMessageBytes,
          maxMessageBytes,
        });
      }
    }

    if (isWithinAttachmentLimit) {
      completedDocumentEmailAttachments = await Promise.all(
        envelope.envelopeItems.map(async (envelopeItem) => {
          const file = await getFileServerSide(envelopeItem.documentData);

          // Use the envelope title for version 1, and the envelope item title for version 2.
          const fileNameToUse = envelope.internalVersion === 1 ? envelope.title : envelopeItem.title + '.pdf';

          return {
            filename: fileNameToUse.endsWith('.pdf') ? fileNameToUse : fileNameToUse + '.pdf',
            content: Buffer.from(file),
            contentType: 'application/pdf',
          };
        }),
      );
    }
  }

  // Send email to document owner if:
  // 1. Owner document completed emails are enabled AND
  // 2. Either:
  //    - The owner is not a recipient, OR
  //    - Recipient emails are disabled
  if (
    isOwnerDocumentCompletedEmailEnabled &&
    (!envelope.recipients.find((recipient) => recipient.email === owner.email) || !isDocumentCompletedEmailEnabled)
  ) {
    const template = createElement(DocumentCompletedEmailTemplate, {
      documentName: envelope.title,
      assetBaseUrl,
      downloadLink: documentOwnerDownloadLink,
      wasAttachmentDropped,
    });

    const [html, text] = await Promise.all([
      renderEmailWithI18N(template, { lang: emailLanguage, branding }),
      renderEmailWithI18N(template, {
        lang: emailLanguage,
        branding,
        plainText: true,
      }),
    ]);

    const i18n = await getI18nInstance(emailLanguage);

    await emailTransport.sendMail({
      to: [
        {
          name: owner.name || '',
          address: owner.email,
        },
      ],
      from: senderEmail,
      replyTo: replyToEmail,
      subject: i18n._(msg`Signing Complete!`),
      html,
      text,
      attachments: completedDocumentEmailAttachments,
    });

    await prisma.documentAuditLog.create({
      data: createDocumentAuditLogData({
        type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
        envelopeId: envelope.id,
        user: null,
        requestMetadata,
        data: {
          emailType: 'DOCUMENT_COMPLETED',
          recipientEmail: owner.email,
          recipientName: owner.name ?? '',
          recipientId: owner.id,
          recipientRole: 'OWNER',
          isResending: false,
        },
      }),
    });
  }

  if (!isDocumentCompletedEmailEnabled) {
    io.logger.warn({
      msg: 'Recipient completion emails skipped: the documentCompleted email setting is off. Note that any distribution method other than EMAIL forces it off.',
      envelopeId: envelope.id,
      distributionMethod: envelope.documentMeta?.distributionMethod,
    });

    return;
  }

  const recipientsToNotify = envelope.recipients.filter((recipient) => isRecipientEmailValidForSending(recipient));

  await Promise.all(
    recipientsToNotify.map(async (recipient) => {
      // A CC recipient never asked to be part of this document, so their completion
      // email is effectively unsolicited. Meter it against the organisation email
      // quota/stats so it is correctly logged.
      if (recipient.role === RecipientRole.CC) {
        try {
          await assertOrganisationRatesAndLimits({
            organisationId,
            organisationClaim: claims,
            type: 'email',
            count: 1,
          });
        } catch (_err) {
          io.logger.warn({
            msg: 'CC completion email dropped: org email limit exceeded',
            organisationId,
            recipientId: recipient.id,
            envelopeId: envelope.id,
          });

          // On rate/quota exceeded, early return to allow other recipients to be processed.
          return;
        }
      }

      const customEmailTemplate = {
        'signer.name': recipient.name,
        'signer.email': recipient.email,
        'document.name': envelope.title,
      };

      const downloadLink = `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}/complete`;
      const reportUrl =
        recipient.role === RecipientRole.CC ? `${NEXT_PUBLIC_WEBAPP_URL()}/report/${recipient.token}` : undefined;

      const template = createElement(DocumentCompletedEmailTemplate, {
        documentName: envelope.title,
        assetBaseUrl,
        downloadLink: recipient.email === owner.email ? documentOwnerDownloadLink : downloadLink,
        customBody:
          isDirectTemplate && envelope.documentMeta?.message
            ? renderCustomEmailTemplate(envelope.documentMeta.message, customEmailTemplate)
            : undefined,
        reportUrl,
        wasAttachmentDropped,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, {
          lang: emailLanguage,
          branding,
          plainText: true,
        }),
      ]);

      const i18n = await getI18nInstance(emailLanguage);

      await emailTransport.sendMail({
        to: [
          {
            name: recipient.name,
            address: recipient.email,
          },
        ],
        from: senderEmail,
        replyTo: replyToEmail,
        subject:
          isDirectTemplate && envelope.documentMeta?.subject
            ? renderCustomEmailTemplate(envelope.documentMeta.subject, customEmailTemplate)
            : i18n._(msg`Signing Complete!`),
        html,
        text,
        attachments: completedDocumentEmailAttachments,
      });

      await prisma.documentAuditLog.create({
        data: createDocumentAuditLogData({
          type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
          envelopeId: envelope.id,
          user: null,
          requestMetadata,
          data: {
            emailType: 'DOCUMENT_COMPLETED',
            recipientEmail: recipient.email,
            recipientName: recipient.name,
            recipientId: recipient.id,
            recipientRole: recipient.role,
            isResending: false,
          },
        }),
      });
    }),
  );
};

/**
 * The longest download link any of this envelope's completion emails will carry.
 *
 * The owner's link and the recipients' links are different shapes, and the size probe has
 * to measure whichever renders largest so a single decision covers every send.
 */
const getLongestCompletionDownloadLink = (
  recipients: CompletionEmailRecipient[],
  ownerDownloadLink: string,
): string => {
  const downloadLinks = recipients.map((recipient) => `${NEXT_PUBLIC_WEBAPP_URL()}/sign/${recipient.token}/complete`);

  return downloadLinks.reduce((longest, link) => (link.length > longest.length ? link : longest), ownerDownloadLink);
};

/**
 * The report link a CC recipient's completion email carries, if this envelope has one.
 */
const getCompletionReportUrl = (recipients: CompletionEmailRecipient[]): string | undefined => {
  const ccRecipient = recipients.find((recipient) => recipient.role === RecipientRole.CC);

  if (!ccRecipient) {
    return undefined;
  }

  return `${NEXT_PUBLIC_WEBAPP_URL()}/report/${ccRecipient.token}`;
};

type GetLongestCompletionCustomBodyOptions = {
  recipients: CompletionEmailRecipient[];
  documentName: string;
  message: string | null | undefined;
};

/**
 * The longest custom body any of this envelope's completion emails will render.
 *
 * Measured from the real substitutions rather than from the schema's 5000 character bound,
 * because the placeholders expand — a message packed with `{signer.name}` renders far
 * larger than the message itself, so a synthetic bound would have to be roughly twenty
 * times the real value to stay safe.
 */
const getLongestCompletionCustomBody = ({
  recipients,
  documentName,
  message,
}: GetLongestCompletionCustomBodyOptions): string | undefined => {
  if (!message) {
    return undefined;
  }

  const customBodies = recipients.map((recipient) =>
    renderCustomEmailTemplate(message, {
      'signer.name': recipient.name,
      'signer.email': recipient.email,
      'document.name': documentName,
    }),
  );

  return customBodies.reduce<string | undefined>(
    (longest, body) => (longest === undefined || getUtf8ByteLength(body) > getUtf8ByteLength(longest) ? body : longest),
    undefined,
  );
};

type ResolveTotalEnvelopeItemBytesOptions = {
  envelopeId: string;
  documentDataList: GetFileOptions[];
  io: JobRunIO;
};

/**
 * The combined raw size of an envelope's items, read from storage metadata rather than by
 * downloading them.
 *
 * Returns `null` when any size cannot be resolved — a missing object, a transient storage
 * error, or an S3-compatible endpoint that does not report a content length. The size is
 * then unknown rather than zero, and the caller treats it as over the cap, since failing
 * safe against the transport error is the point of the cap in the first place.
 */
const resolveTotalEnvelopeItemBytes = async ({
  envelopeId,
  documentDataList,
  io,
}: ResolveTotalEnvelopeItemBytesOptions): Promise<number | null> => {
  try {
    const sizes = await Promise.all(documentDataList.map(async (documentData) => getFileSizeServerSide(documentData)));

    return sizes.reduce((total, size) => total + size, 0);
  } catch (err) {
    io.logger.warn({
      msg: 'Completion email attachment size probe failed; treating the attachments as too large',
      envelopeId,
      err,
    });

    return null;
  }
};
