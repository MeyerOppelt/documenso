import { describe, expect, it } from 'vitest';

import { MIME_OVERHEAD_ALLOWANCE } from '../constants/email';
import { getBase64EncodedSize, getUtf8ByteLength, shouldAttachCompletedDocuments } from './email-attachments';

describe('getBase64EncodedSize', () => {
  it('inflates the raw size by the base64 overhead', () => {
    expect(getBase64EncodedSize(0)).toBe(0);
    expect(getBase64EncodedSize(3)).toBe(4);
    expect(getBase64EncodedSize(1)).toBe(4);
    expect(getBase64EncodedSize(3_000_000)).toBe(4_000_000);
  });
});

describe('getUtf8ByteLength', () => {
  it('counts encoded bytes rather than code units', () => {
    expect(getUtf8ByteLength('abc')).toBe(3);
    expect(getUtf8ByteLength('“”')).toBe(6);
  });
});

describe('shouldAttachCompletedDocuments', () => {
  it('does not attach when the envelope setting is disabled', () => {
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: false,
        encodedAttachmentBytes: 1024,
        renderedMessageBytes: 20_000,
        maxMessageBytes: null,
      }),
    ).toBe(false);
  });

  it('attaches any size when no cap is in effect', () => {
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes: 500_000_000,
        renderedMessageBytes: 20_000,
        maxMessageBytes: null,
      }),
    ).toBe(true);
  });

  it('never attaches when the cap is zero, even for an empty payload', () => {
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes: 0,
        renderedMessageBytes: 0,
        maxMessageBytes: 0,
      }),
    ).toBe(false);
  });

  it('attaches a message under the cap', () => {
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes: 1_000_000,
        renderedMessageBytes: 20_000,
        maxMessageBytes: 2_000_000,
      }),
    ).toBe(true);
  });

  it('attaches a message exactly at the cap', () => {
    const encodedAttachmentBytes = 1_000_000;
    const renderedMessageBytes = 20_000;

    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes,
        renderedMessageBytes,
        maxMessageBytes: encodedAttachmentBytes + renderedMessageBytes + MIME_OVERHEAD_ALLOWANCE,
      }),
    ).toBe(true);
  });

  it('rejects a message one byte over the cap', () => {
    const encodedAttachmentBytes = 1_000_000;
    const renderedMessageBytes = 20_000;

    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes,
        renderedMessageBytes,
        maxMessageBytes: encodedAttachmentBytes + renderedMessageBytes + MIME_OVERHEAD_ALLOWANCE - 1,
      }),
    ).toBe(false);
  });

  it('rejects a payload that only exceeds the cap once base64 encoded', () => {
    // 20 MB raw encodes to ~26.7 MB, which does not fit a 25 MB provider limit.
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes: getBase64EncodedSize(20_000_000),
        renderedMessageBytes: 20_000,
        maxMessageBytes: 25_000_000,
      }),
    ).toBe(false);
  });

  it('rejects a payload pushed over the cap by the rendered bodies alone', () => {
    const maxMessageBytes = 2_000_000;
    const encodedAttachmentBytes = maxMessageBytes - MIME_OVERHEAD_ALLOWANCE - 1_000;

    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes,
        renderedMessageBytes: 999,
        maxMessageBytes,
      }),
    ).toBe(true);

    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes,
        renderedMessageBytes: 1_001,
        maxMessageBytes,
      }),
    ).toBe(false);
  });

  it('rejects an unresolved attachment size, which arrives as Infinity', () => {
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes: Number.POSITIVE_INFINITY,
        renderedMessageBytes: 20_000,
        maxMessageBytes: 2_000_000,
      }),
    ).toBe(false);
  });

  it('still attaches an unresolved size when no cap is in effect, since nothing is compared', () => {
    expect(
      shouldAttachCompletedDocuments({
        isAttachmentEnabled: true,
        encodedAttachmentBytes: Number.POSITIVE_INFINITY,
        renderedMessageBytes: 20_000,
        maxMessageBytes: null,
      }),
    ).toBe(true);
  });
});
