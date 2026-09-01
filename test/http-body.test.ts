import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { type IncomingMessage } from 'node:http';
import { MAX_BODY_BYTES, PayloadTooLargeError, readBody } from '../src/http-body.js';

// A minimal stand-in for IncomingMessage: readBody only touches
// on/removeAllListeners/pause, all of which EventEmitter already provides.
function fakeRequest(): IncomingMessage & { pauseCalls: number } {
  const req = new EventEmitter() as unknown as IncomingMessage & { pauseCalls: number };
  req.pauseCalls = 0;
  (req as unknown as { pause: () => void }).pause = () => {
    req.pauseCalls += 1;
  };
  return req;
}

describe('readBody', () => {
  it('resolves with the concatenated body on a normal request', async () => {
    const req = fakeRequest();
    const promise = readBody(req);
    req.emit('data', Buffer.from('{"jsonrpc":'));
    req.emit('data', Buffer.from('"2.0"}'));
    req.emit('end');

    await expect(promise).resolves.toBe('{"jsonrpc":"2.0"}');
  });

  it('resolves to an empty string when the request has no body', async () => {
    const req = fakeRequest();
    const promise = readBody(req);
    req.emit('end');

    await expect(promise).resolves.toBe('');
  });

  it('rejects with PayloadTooLargeError once the body exceeds MAX_BODY_BYTES', async () => {
    const req = fakeRequest();
    const promise = readBody(req);

    // One chunk right at the limit, then a byte that pushes it over.
    req.emit('data', Buffer.alloc(MAX_BODY_BYTES));
    req.emit('data', Buffer.from('x'));

    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
    // The reader stops consuming the stream once it gives up on the body.
    expect(req.pauseCalls).toBe(1);
  });

  it('ignores further data/end events once rejected for size', async () => {
    const req = fakeRequest();
    const promise = readBody(req);

    req.emit('data', Buffer.alloc(MAX_BODY_BYTES + 1));
    // A late 'end' (e.g. if a caller re-registered a listener) must not
    // resolve the same promise after it already rejected.
    req.emit('end');

    await expect(promise).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it('propagates a stream error', async () => {
    const req = fakeRequest();
    const promise = readBody(req);
    const boom = new Error('socket hang up');
    req.emit('error', boom);

    await expect(promise).rejects.toBe(boom);
  });
});
