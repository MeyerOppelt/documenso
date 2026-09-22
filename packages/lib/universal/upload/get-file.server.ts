import { DocumentDataType } from '@prisma/client';
import { base64 } from '@scure/base';
import { match } from 'ts-pattern';

import { getFileSize, getPresignGetUrl } from './server-actions';

export type GetFileOptions = {
  type: DocumentDataType;
  data: string;
};

export const getFileServerSide = async ({ type, data }: GetFileOptions) => {
  return await match(type)
    .with(DocumentDataType.BYTES, () => getFileFromBytes(data))
    .with(DocumentDataType.BYTES_64, () => getFileFromBytes64(data))
    .with(DocumentDataType.S3_PATH, async () => getFileFromS3(data))
    .exhaustive();
};

/**
 * The size in bytes of a document's file, resolved without transferring it.
 *
 * Used to decide whether a completion email's attachments fit the transport's message
 * size limit before paying to download them. Throws when the size cannot be determined,
 * which callers treat as "too large" rather than "free".
 */
export const getFileSizeServerSide = async ({ type, data }: GetFileOptions): Promise<number> => {
  return await match(type)
    .with(DocumentDataType.BYTES, () => getBytesSize(data))
    .with(DocumentDataType.BYTES_64, () => getBytes64Size(data))
    .with(DocumentDataType.S3_PATH, async () => getFileSize(data))
    .exhaustive();
};

const getBytesSize = (data: string) => new TextEncoder().encode(data).length;

/**
 * Derived arithmetically rather than by decoding: every 4 base64 characters carry 3 bytes,
 * and the trailing `=` padding carries none. Decoding to measure would allocate the whole
 * payload, which is the exact cost the size probe exists to avoid.
 *
 * Exported for the unit tests, which assert it against `base64.decode(...).length`.
 */
export const getBytes64Size = (data: string) => {
  const paddingLength = data.endsWith('==') ? 2 : Number(data.endsWith('='));

  return Math.floor(((data.length - paddingLength) * 3) / 4);
};

const getFileFromBytes = (data: string) => {
  const encoder = new TextEncoder();

  const binaryData = encoder.encode(data);

  return binaryData;
};

const getFileFromBytes64 = (data: string) => {
  const binaryData = base64.decode(data);

  return binaryData;
};

const getFileFromS3 = async (key: string) => {
  const { url } = await getPresignGetUrl(key);

  const response = await fetch(url, {
    method: 'GET',
  });

  if (!response.ok) {
    throw new Error(`Failed to get file "${key}", failed with status code ${response.status}`);
  }

  const buffer = await response.arrayBuffer();

  const binaryData = new Uint8Array(buffer);

  return binaryData;
};
