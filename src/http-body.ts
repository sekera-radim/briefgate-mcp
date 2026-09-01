// Bounded request-body reader for the Streamable HTTP transport.
// Split out from index.ts so it can be unit-tested without importing that
// module, which starts a real transport as a side effect of being loaded.

import { type IncomingMessage } from 'node:http';

// Caps memory per request and stops a slow/huge-body POST from tying up the
// process — 2 MB comfortably covers the largest legitimate tool call (a
// define_intake with 100 items) with headroom to spare.
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class PayloadTooLargeError extends Error {}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer | string) => {
      if (rejected) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        // Stop accumulating further chunks in memory; the caller closes the
        // socket once it sees this rejection.
        req.removeAllListeners('data');
        req.pause();
        reject(new PayloadTooLargeError(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}
