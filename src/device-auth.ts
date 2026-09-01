// Minimal client for the BriefGate device-authorization endpoints
// (POST /v1/auth/device/start, POST /v1/auth/device/poll) and key revocation
// (DELETE /v1/keys/current).
//
// Deliberately not routed through client.ts's apiRequest for the device-flow
// calls: every other call in this package carries a Bearer API key, but these
// two are how a key is obtained in the first place, so they must never send
// an Authorization header. revokeCurrentKey does send one — the key being
// revoked, not the caller's operator config — so it isn't a client.ts call
// either; a 401 there means "already revoked," not the generic auth failure
// client.ts's throwApiError reports.

const FETCH_TIMEOUT_MS = 15_000;

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DevicePollSuccess {
  api_key: string;
  key_id: string;
  account_name: string;
  scopes: string[];
}

export type DevicePollOutcome =
  | { status: 'success'; result: DevicePollSuccess }
  | { status: 'pending' }
  | { status: 'slow_down'; retryAfterSeconds?: number }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'denied' }
  // The device_code itself isn't recognized (e.g. the server restarted) —
  // distinct from "expired": there is no code to have expired.
  | { status: 'unknown_code' };

interface RawResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

async function request(baseUrl: string, path: string, init: RequestInit): Promise<RawResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`BriefGate request to ${path} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`BriefGate API unreachable: ${detail}.`);
  } finally {
    clearTimeout(timeoutId);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // Non-JSON or empty body (e.g. a 204) — callers validate the fields they
    // need and fail there.
    body = undefined;
  }
  return { status: res.status, body, headers: res.headers };
}

function postJson(baseUrl: string, path: string, payload: unknown): Promise<RawResponse> {
  return request(baseUrl, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });
}

function errorMessage(body: unknown, status: number): string {
  const parsed = body as { message?: string; reason?: string; error?: string } | undefined;
  return parsed?.message ?? parsed?.reason ?? parsed?.error ?? `HTTP ${status}`;
}

/**
 * The server reports which case a non-2xx response is with a `reason` field
 * (some earlier drafts of this contract used `error` for the same purpose) —
 * checked defensively under both names since it costs nothing and the exact
 * key is easy to get wrong across a contract handoff.
 */
function reasonOf(body: unknown): string | undefined {
  const parsed = body as { reason?: string; error?: string } | undefined;
  return parsed?.reason ?? parsed?.error;
}

export async function startDeviceAuth(
  baseUrl: string,
  clientName: string,
  scopes?: string[],
): Promise<DeviceStart> {
  const { status, body } = await postJson(baseUrl, '/auth/device/start', {
    client_name: clientName,
    ...(scopes ? { scopes } : {}),
  });
  // The API answers 201: a device code is a resource it just created.
  if (status !== 200 && status !== 201) {
    throw new Error(`Could not start sign-in: ${errorMessage(body, status)}`);
  }
  return body as DeviceStart;
}

export async function pollDeviceAuth(baseUrl: string, deviceCode: string): Promise<DevicePollOutcome> {
  const { status, body, headers } = await postJson(baseUrl, '/auth/device/poll', { device_code: deviceCode });

  if (status === 200) return { status: 'success', result: body as DevicePollSuccess };
  if (status === 428) return { status: 'pending' };
  if (status === 429) {
    const retryAfter = headers.get('Retry-After');
    const retryAfterSeconds = retryAfter ? parseInt(retryAfter, 10) : NaN;
    return { status: 'slow_down', ...(isNaN(retryAfterSeconds) ? {} : { retryAfterSeconds }) };
  }
  if (status === 404) return { status: 'unknown_code' };
  if (status === 403) return { status: 'denied' };
  if (status === 410) {
    // Distinguishes "expired" from "consumed" by reason; defaults to
    // "expired" for a 410 that doesn't specify one.
    return reasonOf(body) === 'device_code_consumed' || reasonOf(body) === 'consumed'
      ? { status: 'consumed' }
      : { status: 'expired' };
  }

  throw new Error(`Unexpected response while checking sign-in status: ${errorMessage(body, status)}`);
}

export type RevokeOutcome = 'revoked' | 'already_revoked' | 'failed';

/**
 * Best-effort server-side revocation for `logout`. Never throws — a network
 * failure is reported as 'failed' so the caller can still remove the local
 * credential and tell the user to revoke it from the dashboard instead.
 */
export async function revokeCurrentKey(baseUrl: string, apiKey: string): Promise<RevokeOutcome> {
  try {
    const { status } = await request(baseUrl, '/keys/current', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (status === 204) return 'revoked';
    if (status === 401) return 'already_revoked'; // the key it would revoke is already gone
    return 'failed';
  } catch (err) {
    console.error(`[briefgate] could not revoke the key remotely: ${(err as Error).message}`);
    return 'failed';
  }
}
