import { MIME_OVERHEAD_ALLOWANCE } from '../constants/email';

type ShouldAttachCompletedDocumentsOptions = {
  /**
   * The per-envelope `attachCompletedDocument` email setting.
   */
  isAttachmentEnabled: boolean;
  /**
   * The combined size of the attachment payloads once base64 encoded, in bytes.
   *
   * `Infinity` when a size could not be resolved, which never fits a numeric cap.
   */
  encodedAttachmentBytes: number;
  /**
   * The combined size of the rendered HTML and plain text bodies, in bytes.
   */
  renderedMessageBytes: number;
  /**
   * `null` for no cap, `0` to never attach, otherwise the max rendered message in bytes.
   */
  maxMessageBytes: number | null;
};

/**
 * The size an email transport actually carries for a given raw payload, since attachments
 * go over the wire base64-encoded and that inflates them by roughly 37%.
 */
export const getBase64EncodedSize = (rawBytes: number) => Math.ceil(rawBytes / 3) * 4;

export const getUtf8ByteLength = (value: string) => new TextEncoder().encode(value).length;

/**
 * Whether the completed documents should be attached to a document completed email, or
 * whether the email should go out with its download link alone.
 *
 * The comparison is against the whole rendered message — encoded attachments, both bodies
 * and an allowance for MIME headers and boundaries — because that is what a provider's
 * published message size limit measures.
 */
export const shouldAttachCompletedDocuments = ({
  isAttachmentEnabled,
  encodedAttachmentBytes,
  renderedMessageBytes,
  maxMessageBytes,
}: ShouldAttachCompletedDocumentsOptions): boolean => {
  if (!isAttachmentEnabled) {
    return false;
  }

  // Unset, so no cap applies and the attachment goes out regardless of size.
  if (maxMessageBytes === null) {
    return true;
  }

  // The kill switch, which is independent of the payload size.
  if (maxMessageBytes === 0) {
    return false;
  }

  const messageBytes = encodedAttachmentBytes + renderedMessageBytes + MIME_OVERHEAD_ALLOWANCE;

  return messageBytes <= maxMessageBytes;
};
