import type { DocumentMeta } from '@prisma/client';
import { DocumentDistributionMethod } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { extractDerivedDocumentEmailSettings } from './document-email';

type BuildDocumentMetaOptions = {
  distributionMethod?: DocumentDistributionMethod;
  emailSettings?: unknown;
};

const buildDocumentMeta = ({ distributionMethod, emailSettings }: BuildDocumentMetaOptions) =>
  // The stored settings are an untyped JSON column, so the test feeds it raw shapes.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  ({
    distributionMethod: distributionMethod ?? DocumentDistributionMethod.EMAIL,
    emailSettings,
  }) as unknown as DocumentMeta;

describe('extractDerivedDocumentEmailSettings', () => {
  it('defaults attachCompletedDocument to true when the key is absent from stored JSON', () => {
    const settings = extractDerivedDocumentEmailSettings(
      buildDocumentMeta({ emailSettings: { documentCompleted: true } }),
    );

    expect(settings.attachCompletedDocument).toBe(true);
  });

  it('defaults attachCompletedDocument to true when there is no document meta at all', () => {
    expect(extractDerivedDocumentEmailSettings(null).attachCompletedDocument).toBe(true);
  });

  it('reads a stored false', () => {
    const settings = extractDerivedDocumentEmailSettings(
      buildDocumentMeta({ emailSettings: { attachCompletedDocument: false } }),
    );

    expect(settings.attachCompletedDocument).toBe(false);
  });

  it('preserves the stored value under a non-email distribution method', () => {
    const disabled = extractDerivedDocumentEmailSettings(
      buildDocumentMeta({
        distributionMethod: DocumentDistributionMethod.NONE,
        emailSettings: { attachCompletedDocument: false },
      }),
    );

    // The owner completion email still sends under NONE, so the preference stays meaningful.
    expect(disabled.attachCompletedDocument).toBe(false);
    expect(disabled.documentCompleted).toBe(false);
    expect(disabled.ownerDocumentCompleted).toBe(true);

    const enabled = extractDerivedDocumentEmailSettings(
      buildDocumentMeta({
        distributionMethod: DocumentDistributionMethod.NONE,
        emailSettings: { attachCompletedDocument: true },
      }),
    );

    expect(enabled.attachCompletedDocument).toBe(true);
  });

  it('falls back to the defaults for malformed stored JSON', () => {
    const settings = extractDerivedDocumentEmailSettings(
      buildDocumentMeta({ emailSettings: { attachCompletedDocument: 'nope' } }),
    );

    expect(settings.attachCompletedDocument).toBe(true);
  });
});
