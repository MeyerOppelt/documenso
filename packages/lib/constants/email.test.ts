import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE, resolveMaxCompletedDocumentAttachmentSize } from './email';

describe('MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is null when unset, so the transport default applies', () => {
    vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', undefined);

    expect(MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()).toBeNull();
  });

  it('is null for an empty value rather than zero', () => {
    vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '');

    expect(MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()).toBeNull();
  });

  it('is null for an unparseable value', () => {
    vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', 'abc');

    expect(MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()).toBeNull();
  });

  it('is zero for an explicit zero, which never attaches', () => {
    vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '0');

    expect(MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()).toBe(0);
  });

  it('uses the configured byte cap', () => {
    vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '25000000');

    expect(MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()).toBe(25_000_000);
  });

  it('clamps a negative cap to zero', () => {
    vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '-100');

    expect(MAX_COMPLETED_DOCUMENT_ATTACHMENT_SIZE()).toBe(0);
  });
});

describe('resolveMaxCompletedDocumentAttachmentSize', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('with the environment variable unset', () => {
    it('never attaches over MailChannels, which cannot carry attachments', () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', undefined);

      expect(resolveMaxCompletedDocumentAttachmentSize('MAILCHANNELS')).toBe(0);
    });

    it("uses Resend's documented 40 MB message limit", () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', undefined);

      expect(resolveMaxCompletedDocumentAttachmentSize('RESEND')).toBe(40_000_000);
    });

    it("leaves both SMTP transports uncapped, since the limit is the operator's", () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', undefined);

      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_API')).toBeNull();
      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_AUTH')).toBeNull();
    });

    it('treats an empty value as unset rather than as a zero cap', () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '');

      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_AUTH')).toBeNull();
      expect(resolveMaxCompletedDocumentAttachmentSize('RESEND')).toBe(40_000_000);
    });

    it('treats an unparseable value as unset rather than as a zero cap', () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', 'abc');

      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_AUTH')).toBeNull();
      expect(resolveMaxCompletedDocumentAttachmentSize('RESEND')).toBe(40_000_000);
    });
  });

  describe('with the environment variable set', () => {
    it('overrides every transport default', () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '2000000');

      expect(resolveMaxCompletedDocumentAttachmentSize('MAILCHANNELS')).toBe(2_000_000);
      expect(resolveMaxCompletedDocumentAttachmentSize('RESEND')).toBe(2_000_000);
      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_API')).toBe(2_000_000);
      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_AUTH')).toBe(2_000_000);
    });

    it('applies an explicit zero to every transport', () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '0');

      expect(resolveMaxCompletedDocumentAttachmentSize('MAILCHANNELS')).toBe(0);
      expect(resolveMaxCompletedDocumentAttachmentSize('RESEND')).toBe(0);
      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_API')).toBe(0);
      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_AUTH')).toBe(0);
    });

    it('clamps a negative cap to zero rather than treating it as unset', () => {
      vi.stubEnv('NEXT_PRIVATE_EMAIL_MAX_ATTACHMENT_SIZE', '-100');

      expect(resolveMaxCompletedDocumentAttachmentSize('SMTP_AUTH')).toBe(0);
    });
  });
});
