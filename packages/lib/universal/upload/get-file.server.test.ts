import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';

import { getBytes64Size } from './get-file.server';

describe('getBytes64Size', () => {
  it('matches the decoded length for a payload with no padding', () => {
    const data = base64.encode(new Uint8Array(3));

    expect(data.endsWith('=')).toBe(false);
    expect(getBytes64Size(data)).toBe(base64.decode(data).length);
  });

  it('matches the decoded length for a payload with one padding character', () => {
    const data = base64.encode(new Uint8Array(5));

    expect(data.endsWith('=')).toBe(true);
    expect(data.endsWith('==')).toBe(false);
    expect(getBytes64Size(data)).toBe(base64.decode(data).length);
  });

  it('matches the decoded length for a payload with two padding characters', () => {
    const data = base64.encode(new Uint8Array(4));

    expect(data.endsWith('==')).toBe(true);
    expect(getBytes64Size(data)).toBe(base64.decode(data).length);
  });

  it('matches the decoded length across a run of sizes', () => {
    for (let rawBytes = 0; rawBytes <= 64; rawBytes += 1) {
      const data = base64.encode(new Uint8Array(rawBytes));

      expect(getBytes64Size(data)).toBe(rawBytes);
    }
  });
});
