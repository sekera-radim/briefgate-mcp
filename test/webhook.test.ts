import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, parseWebhookEvent } from '../src/webhook.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeHeader(secret: string, rawBody: string, t: number): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

// Sampled per assertion, not once at module load. A header built at
// load time plus 301 seconds is only 300 seconds away once a single second
// has ticked — exactly on the tolerance boundary, so the check passes and the
// test fails. That made this file pass locally and fail in CI.
const now = (): number => Math.floor(Date.now() / 1000);
const SECRET = 'whsec_test_secret_1234567890abcdef';
const BODY = JSON.stringify({ event: 'item.submitted', intake_id: 'in_1', account_id: 'acc_1', created_at: '2026-07-16T12:00:00Z', item_key: 'logo', item_status: 'submitted' });

// ─── verifyWebhookSignature ───────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  it('returns true for a valid signature with current timestamp', () => {
    const header = makeHeader(SECRET, BODY, now());
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(true);
  });

  it('returns true when timestamp is within tolerance (default 300s)', () => {
    const header = makeHeader(SECRET, BODY, now() - 280);
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(true);
  });

  it('returns false when timestamp exceeds default tolerance (>300s)', () => {
    const header = makeHeader(SECRET, BODY, now() - 320);
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(false);
  });

  it('returns false when timestamp exceeds default tolerance in the future', () => {
    const header = makeHeader(SECRET, BODY, now() + 320);
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(false);
  });

  it('respects custom toleranceSec option', () => {
    const header = makeHeader(SECRET, BODY, now() - 600);
    expect(verifyWebhookSignature(SECRET, header, BODY, { toleranceSec: 700 })).toBe(true);
    expect(verifyWebhookSignature(SECRET, header, BODY, { toleranceSec: 500 })).toBe(false);
  });

  it('returns false for a tampered body', () => {
    const header = makeHeader(SECRET, BODY, now());
    const tamperedBody = BODY.replace('item.submitted', 'intake.completed');
    expect(verifyWebhookSignature(SECRET, header, tamperedBody)).toBe(false);
  });

  it('returns false for a wrong secret', () => {
    const header = makeHeader('wrong_secret', BODY, now());
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(false);
  });

  it('returns false for a malformed header (missing t field)', () => {
    expect(verifyWebhookSignature(SECRET, 'v1=abc123', BODY)).toBe(false);
  });

  it('returns false for a malformed header (missing v1 field)', () => {
    expect(verifyWebhookSignature(SECRET, `t=${now()}`, BODY)).toBe(false);
  });

  it('returns false for an empty header', () => {
    expect(verifyWebhookSignature(SECRET, '', BODY)).toBe(false);
  });

  it('returns false for a v1 hex string of the wrong length', () => {
    // 63-char hex (not 64) should be rejected before comparison
    const shortHex = 'a'.repeat(63);
    const header = `t=${now()},v1=${shortHex}`;
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(false);
  });

  it('is timing-safe: two wrong signatures of equal length both return false', () => {
    // Both have 64-char v1 values so they reach timingSafeEqual; neither should be true
    const valid = createHmac('sha256', SECRET).update(`${now()}.${BODY}`).digest('hex');
    // Flip the last character to create an equally-sized but wrong value
    const wrong = valid.slice(0, -1) + (valid[valid.length - 1] === 'a' ? 'b' : 'a');
    const header = `t=${now()},v1=${wrong}`;
    expect(verifyWebhookSignature(SECRET, header, BODY)).toBe(false);
  });
});

// ─── parseWebhookEvent ────────────────────────────────────────────────────────

describe('parseWebhookEvent', () => {
  it('parses a valid item.submitted event', () => {
    const event = parseWebhookEvent(BODY);
    expect(event.event).toBe('item.submitted');
    expect(event.intake_id).toBe('in_1');
  });

  it('parses intake.completed event', () => {
    const body = JSON.stringify({
      event: 'intake.completed',
      intake_id: 'in_2',
      account_id: 'acc_1',
      created_at: '2026-07-16T12:00:00Z',
    });
    const event = parseWebhookEvent(body);
    expect(event.event).toBe('intake.completed');
    expect(event.intake_id).toBe('in_2');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseWebhookEvent('not-json')).toThrow('not valid JSON');
  });

  it('throws when event field is missing', () => {
    const body = JSON.stringify({ intake_id: 'in_1', account_id: 'acc_1' });
    expect(() => parseWebhookEvent(body)).toThrow(/required fields/);
  });

  it('throws when intake_id is missing', () => {
    const body = JSON.stringify({ event: 'item.submitted', account_id: 'acc_1' });
    expect(() => parseWebhookEvent(body)).toThrow(/required fields/);
  });

  it('throws when body is a JSON array, not an object', () => {
    expect(() => parseWebhookEvent('[]')).toThrow('JSON object');
  });
});
