// Backs both the `login`/`logout` MCP tools and the `login`/`logout` CLI
// subcommands — same functions, two presentations:
//
//   - `login()` is two-phase, for an MCP tool call: a human clicking Allow in
//     a browser can take minutes, longer than most MCP clients let one tool
//     call block, so the first call starts the flow and returns immediately;
//     a later call (prompted by the tool's own description) picks up
//     whatever a background poll loop has found by then.
//   - `loginBlocking()` is for the CLI: a terminal command can just block
//     until the flow finishes, so it prints the code once and waits.
//
// Both format their own prose from the same structured LoginOutcome, so the
// state machine (device-auth.ts's status values, retry/backoff, timeout)
// lives in exactly one place: runPolling below.
import { spawn } from 'node:child_process';
import { startDeviceAuth, pollDeviceAuth, revokeCurrentKey } from './device-auth.js';
import { saveCredential, loadCredential, deleteCredential } from './credentials.js';

// ─── Shared state machine ──────────────────────────────────────────────────────

export type LoginOutcome =
  | { ok: true; apiKey: string; keyId: string; accountName: string; scopes: string[] }
  | { ok: false; reason: 'expired' | 'consumed' | 'denied' | 'unknown_code' | 'timeout' | 'error'; detail?: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url: string): void {
  // Headless boxes (an SSH session, CI) have nothing to open, and tests must
  // never pop a real browser on the developer's desk.
  if (process.env['BRIEFGATE_NO_BROWSER']) return;
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  // The URL is already printed; a browser is a convenience. A missing opener
  // surfaces as an 'error' event on the child, which would crash the process
  // if nobody listened.
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      console.error(`[briefgate] could not open a browser (${err.message}); open the URL yourself.`);
    });
    child.unref();
  } catch (err) {
    console.error(`[briefgate] could not open a browser (${(err as Error).message}); open the URL yourself.`);
  }
}

async function runPolling(
  baseUrl: string,
  deviceCode: string,
  intervalSec: number,
  expiresInSec: number,
): Promise<LoginOutcome> {
  const deadline = Date.now() + expiresInSec * 1000;
  let interval = intervalSec;

  while (Date.now() < deadline) {
    await sleep(interval * 1000);

    let outcome;
    try {
      outcome = await pollDeviceAuth(baseUrl, deviceCode);
    } catch (err) {
      // A blip on the network is not a decision; keep waiting for one.
      console.error(`[briefgate] sign-in check failed, retrying: ${(err as Error).message}`);
      continue;
    }

    switch (outcome.status) {
      case 'success':
        saveCredential(baseUrl, {
          api_key: outcome.result.api_key,
          key_id: outcome.result.key_id,
          account_name: outcome.result.account_name,
          saved_at: new Date().toISOString(),
        });
        return {
          ok: true,
          apiKey: outcome.result.api_key,
          keyId: outcome.result.key_id,
          accountName: outcome.result.account_name,
          scopes: outcome.result.scopes,
        };
      case 'pending':
        continue;
      case 'slow_down':
        // Honor the server's Retry-After when it sends one; otherwise just
        // double, per RFC 8628.
        interval = outcome.retryAfterSeconds ?? interval * 2;
        continue;
      case 'expired':
        return { ok: false, reason: 'expired' };
      case 'consumed':
        return { ok: false, reason: 'consumed' };
      case 'denied':
        return { ok: false, reason: 'denied' };
      case 'unknown_code':
        return { ok: false, reason: 'unknown_code' };
    }
  }

  return { ok: false, reason: 'timeout' };
}

function describeForTool(outcome: LoginOutcome): string {
  if (outcome.ok) {
    return `Signed in as ${outcome.accountName} (key ${outcome.keyId}, scopes: ${outcome.scopes.join(', ')}).`;
  }
  switch (outcome.reason) {
    case 'expired':
      return 'The sign-in code expired before it was approved. Call `login` again to get a new one.';
    case 'consumed':
      return 'This sign-in code was already used. Call `login` again to get a new one.';
    case 'denied':
      return 'Sign-in was denied in the browser. Call `login` again to try once more.';
    case 'unknown_code':
      return 'The sign-in code was not recognized by the server. Call `login` again to get a new one.';
    case 'timeout':
      return 'Timed out waiting for approval (10 minutes). Call `login` again to get a new code.';
    case 'error':
      return `Sign-in failed: ${outcome.detail}`;
  }
}

// ─── login() — two-phase, for the MCP tool ─────────────────────────────────────

interface InFlightLogin {
  userCode: string;
  verificationUriComplete: string;
  settled: boolean;
  outcome?: LoginOutcome;
  // Kept so a rejection inside the poll loop can't become an unhandled
  // rejection — every consumer reads `settled`/`outcome` instead of awaiting
  // this directly.
  promise: Promise<LoginOutcome>;
}

// Keyed by base URL: this process only ever needs one login in flight per
// BriefGate deployment it talks to (production vs. a staging BRIEFGATE_BASE_URL).
// Independent of loginBlocking() below, so a CLI `login` and an agent's
// `login` tool call never interfere with each other.
const inFlight = new Map<string, InFlightLogin>();

export interface LoginArgs {
  baseUrl: string;
  clientName: string;
}

export interface LoginResult {
  text: string;
  /** Set only on the call that observes success — lets the caller (tools.ts)
   *  update its own in-memory BriefGateConfig without waiting for a restart. */
  apiKey?: string;
}

/**
 * Starts (or checks on) a device-authorization login for `baseUrl`.
 * Never throws — failures come back as text explaining what happened.
 */
export async function login({ baseUrl, clientName }: LoginArgs): Promise<LoginResult> {
  const existing = inFlight.get(baseUrl);
  if (existing) {
    if (existing.settled && existing.outcome) {
      inFlight.delete(baseUrl);
      const outcome = existing.outcome;
      return { text: describeForTool(outcome), apiKey: outcome.ok ? outcome.apiKey : undefined };
    }
    if (!existing.settled) {
      return {
        text: `Still waiting for approval of code ${existing.userCode}. Open ${existing.verificationUriComplete} if you haven't, then call \`login\` again to check.`,
      };
    }
  }

  let start;
  try {
    start = await startDeviceAuth(baseUrl, clientName);
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err) };
  }

  const entry: InFlightLogin = {
    userCode: start.user_code,
    verificationUriComplete: start.verification_uri_complete,
    settled: false,
    promise: Promise.resolve({ ok: false, reason: 'error' as const }), // placeholder, replaced immediately below
  };
  entry.promise = runPolling(baseUrl, start.device_code, start.interval, start.expires_in)
    .catch(
      (err): LoginOutcome => ({
        ok: false,
        reason: 'error',
        detail: err instanceof Error ? err.message : String(err),
      }),
    )
    .then((outcome) => {
      entry.settled = true;
      entry.outcome = outcome;
      return outcome;
    });
  inFlight.set(baseUrl, entry);

  openBrowser(start.verification_uri_complete);

  return {
    text: `Open ${start.verification_uri_complete} and confirm code ${start.user_code}. I'll wait up to 10 minutes — call \`login\` again once you've approved it, or any time to check progress.`,
  };
}

// ─── loginBlocking() — one-shot, for the CLI subcommand ────────────────────────

export interface LoginBlockingResult {
  ok: boolean;
  /** One-line summary for stdout/stderr — success message or failure reason. */
  text: string;
  apiKey?: string;
}

/**
 * Runs the whole device-authorization flow to completion, blocking until it
 * resolves (or times out at 10 minutes). `onCode` fires once, as soon as the
 * code is known, so the caller can print it and open the browser before this
 * promise settles. Independent of the `login()` in-flight map above.
 */
export async function loginBlocking(
  { baseUrl, clientName }: LoginArgs,
  onCode: (info: { userCode: string; verificationUriComplete: string }) => void,
): Promise<LoginBlockingResult> {
  const start = await startDeviceAuth(baseUrl, clientName);
  onCode({ userCode: start.user_code, verificationUriComplete: start.verification_uri_complete });
  openBrowser(start.verification_uri_complete);

  const outcome = await runPolling(baseUrl, start.device_code, start.interval, start.expires_in);
  if (outcome.ok) {
    return { ok: true, text: `Signed in as ${outcome.accountName}.`, apiKey: outcome.apiKey };
  }
  const reasonText: Record<Exclude<LoginOutcome, { ok: true }>['reason'], string> = {
    expired: 'The sign-in code expired before it was approved.',
    consumed: 'This sign-in code was already used.',
    denied: 'Sign-in was denied.',
    unknown_code: 'The sign-in code was not recognized by the server.',
    timeout: 'Timed out waiting for approval (10 minutes).',
    error: outcome.detail ?? 'Sign-in failed.',
  };
  return { ok: false, text: reasonText[outcome.reason] };
}

// ─── logout() — shared by the MCP tool and the CLI subcommand ─────────────────

/**
 * Removes the locally stored key for `baseUrl` and best-effort revokes it on
 * the server. A network failure while revoking never blocks the local
 * removal — the caller is told to revoke it from the dashboard instead.
 */
export async function logout(baseUrl: string): Promise<string> {
  inFlight.delete(baseUrl);

  const existing = loadCredential(baseUrl);
  if (!existing) {
    return `No locally stored key for ${baseUrl} — nothing to do.`;
  }

  const revoked = await revokeCurrentKey(baseUrl, existing.api_key);
  deleteCredential(baseUrl);

  if (revoked === 'failed') {
    return `Signed out of ${baseUrl} locally. Key could not be revoked remotely; revoke it on the keys page.`;
  }
  return `Signed out of ${baseUrl} and revoked the key.`;
}
