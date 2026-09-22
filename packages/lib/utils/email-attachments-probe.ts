import type { BrandingSettings } from '@documenso/email/providers/branding';
import { DocumentCompletedEmailTemplate } from '@documenso/email/templates/document-completed';
import { createElement } from 'react';

import { DOCUMENT_TITLE_MAX_LENGTH } from '../constants/document';
import { getUtf8ByteLength } from './email-attachments';
import { renderEmailWithI18N } from './render-email-with-i18n';

type RenderCompletedEmailProbeSizeOptions = {
  assetBaseUrl: string;
  branding: BrandingSettings;
  emailLanguage: string;
  /**
   * The longest download link any of this envelope's completion emails will carry.
   */
  downloadLink: string;
  /**
   * The longest custom body any of this envelope's completion emails will carry, or
   * `undefined` when none of them use one.
   */
  customBody: string | undefined;
  /**
   * The report link a CC recipient's email will carry, if this envelope has one.
   */
  reportUrl: string | undefined;
};

/**
 * The rendered size of the largest completion email this envelope will produce, in bytes.
 *
 * Providers cap the whole message rather than the attachments alone, so the attachment
 * decision has to be made against a number comparable to the one they publish. The owner
 * email and each recipient email render differently, so measuring the real ones would mean
 * deciding inside the recipient fan-out and sending different parties to the same envelope
 * differently shaped emails. Instead this measures one worst-case render and the caller
 * applies the single result to every send.
 *
 * The "too large to attach" notice is always included, since the notice depends on the
 * decision that depends on the body. The no-drop case therefore measures a couple of
 * hundred bytes heavy, which errs towards dropping an attachment that would just barely
 * have fit rather than sending one that just barely does not.
 */
export const renderCompletedEmailProbeSize = async ({
  assetBaseUrl,
  branding,
  emailLanguage,
  downloadLink,
  customBody,
  reportUrl,
}: RenderCompletedEmailProbeSizeOptions): Promise<number> => {
  // A custom body replaces the document title line rather than joining it, so when this
  // envelope has one both shapes are measured and the larger wins.
  const customBodyVariants = customBody ? [customBody, undefined] : [undefined];

  const renderedSizes = await Promise.all(
    customBodyVariants.map(async (variant) => {
      const template = createElement(DocumentCompletedEmailTemplate, {
        documentName: 'W'.repeat(DOCUMENT_TITLE_MAX_LENGTH),
        assetBaseUrl,
        downloadLink,
        customBody: variant,
        reportUrl,
        wasAttachmentDropped: true,
      });

      const [html, text] = await Promise.all([
        renderEmailWithI18N(template, { lang: emailLanguage, branding }),
        renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
      ]);

      return getUtf8ByteLength(html) + getUtf8ByteLength(text);
    }),
  );

  return Math.max(...renderedSizes);
};
