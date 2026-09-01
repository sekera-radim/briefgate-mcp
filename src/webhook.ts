// Webhook signature verification and event parsing.
//
// Export path: @briefgate/mcp/webhook
// This module is kept separate so consumers can import it without pulling in
// the full MCP server and its SDK dependencies.

import { createHmac, timingSafeEqual } from 'node:crypto';

// ─── Webhook event types ──────────────────────────────────────────────────────

export type BriefGateWebhookEventType =
  | 'item.submitted'
  | 'intake.completed'
  | 'client.viewed'
  | 'chase.bounced'
  | 'intake.stalled'
  | 'intake.overdue';

interface BaseEvent {
  event: BriefGateWebhookEventType;
  intake_id: string;
  account_id: string;
  created_at: string;
}

export interface ItemSubmittedEvent extends BaseEvent {
  event: 'item.submitted';
  item_key: string;
  item_status: 'submitted';
}

export interface IntakeCompletedEvent extends BaseEvent {
  event: 'intake.completed';
}

export interface ClientViewedEvent extends BaseEvent {
  event: 'client.viewed';
  client_email: string;
}

/** The due date passed with required items still outstanding. */
export interface IntakeOverdueEvent extends BaseEvent {
  event: 'intake.overdue';
  project_name: string;
  due_date: string;
  outstanding_items: number;
}

export interface ChaseBounced extends BaseEvent {
  event: 'chase.bounced';
  channel: 'email' | 'sms';
  reason?: string;
}

export interface IntakeStalledEvent extends BaseEvent {
  event: 'intake.stalled';
  attempts: number;
}

export type BriefGateWebhookEvent =
  | ItemSubmittedEvent
  | IntakeCompletedEvent
  | ClientViewedEvent
  | ChaseBounced
  | IntakeStalledEvent;

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Verify a BriefGate webhook delivery.
 *
 * BriefGate signs each webhook body with HMAC-SHA256 over `${t}.${rawBody}`
 * and sends the result in `X-BriefGate-Signature` as `t=<unix>,v1=<hex>`.
 *
 * This function performs a timing-safe comparison and rejects requests whose
 * timestamp falls outside the tolerance window (replay protection).
 *
 * @param secret    Webhook secret configured in the BriefGate dashboard.
 * @param header    Value of the `X-BriefGate-Signature` header.
 * @param rawBody   Raw request body string — do not JSON-parse before passing.
 * @param opts      Optional: toleranceSec (default 300).
 * @returns true if the signature is valid and the timestamp is fresh.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  opts?: { toleranceSec?: number },
): boolean {
  const toleranceSec = opts?.toleranceSec ?? 300;

  const parsed = parseSignatureHeader(header);
  if (!parsed) return false;
  const { t, v1 } = parsed;

  // Reject requests outside the replay-protection window.
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > toleranceSec) return false;

  // Recompute HMAC over the same payload the server signed.
  const payload = `${t}.${rawBody}`;
  const actualHex = createHmac('sha256', secret).update(payload).digest('hex');

  // Timing-safe comparison prevents side-channel attacks that infer the
  // correct signature from response time differences.
  try {
    const expected = Buffer.from(v1, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    // Lengths must match before timingSafeEqual; a length mismatch would
    // itself leak information, so we compare lengths first then reject.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * Parse and type a webhook event from a raw body string.
 * Throws if the body is not valid JSON or the event field is missing.
 */
export function parseWebhookEvent(rawBody: string): BriefGateWebhookEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error('Webhook body is not valid JSON.');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Webhook body must be a JSON object.');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['event'] !== 'string' || typeof obj['intake_id'] !== 'string') {
    throw new Error('Webhook event is missing required fields: event, intake_id.');
  }

  return obj as unknown as BriefGateWebhookEvent;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  // Expected format: t=1234567890,v1=abcdef0123...
  const parts: Record<string, string> = {};
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq === -1) return null;
    parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }

  const tStr = parts['t'];
  const v1 = parts['v1'];
  if (!tStr || !v1) return null;

  const t = parseInt(tStr, 10);
  if (isNaN(t)) return null;

  // Reject obviously wrong hex lengths (SHA-256 = 64 hex chars).
  if (v1.length !== 64) return null;

  return { t, v1 };
}
