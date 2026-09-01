import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// login.ts's openBrowser is best-effort and would otherwise really try to
// exec xdg-open/open/start on whatever machine runs this test.
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { login, logout } from '../src/login.js';
import { loadCredential } from '../src/credentials.js';

const BASE = 'https://api.briefgate.dev';

function mockResponse(status: number, body: unknown): Response {
  return { status, json: async () => body, headers: new Headers() } as unknown as Response;
}

function mockStart(overrides: Partial<Record<string, unknown>> = {}): Response {
  return mockResponse(200, {
    device_code: 'dc_default',
    user_code: 'CODE-0000',
    verification_uri: 'https://briefgate.dev/device',
    verification_uri_complete: 'https://briefgate.dev/device?code=CODE-0000',
    expires_in: 600,
    interval: 1,
    ...overrides,
  });
}

let dir: string;
const ORIGINAL_ENV = process.env['BRIEFGATE_CREDENTIALS_FILE'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'briefgate-mcp-login-test-'));
  process.env['BRIEFGATE_CREDENTIALS_FILE'] = join(dir, 'credentials.json');
  vi.stubGlobal('fetch', vi.fn());
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  // Every test below uses the same BASE — clear any login this process still
  // thinks is in flight, and any credential it saved, so the next test starts
  // from a clean slate. logout() now makes a network call (best-effort
  // revoke); the default unmocked fetch() resolves to undefined, which
  // revokeCurrentKey's own try/catch turns into 'failed' — never throws.
  await logout(BASE);
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env['BRIEFGATE_CREDENTIALS_FILE'];
  else process.env['BRIEFGATE_CREDENTIALS_FILE'] = ORIGINAL_ENV;
});

describe('login — phase 1 (start)', () => {
  it('returns the code and URL immediately, without waiting for approval', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());

    const result = await login({ baseUrl: BASE, clientName: 'Claude Code on radim-pc' });

    expect(result.text).toContain('CODE-0000');
    expect(result.text).toContain('https://briefgate.dev/device?code=CODE-0000');
    expect(result.apiKey).toBeUndefined();
  });

  it('sends the client name to /auth/device/start', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());
    await login({ baseUrl: BASE, clientName: 'Claude Code on radim-pc' });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ client_name: 'Claude Code on radim-pc' });
  });
});

describe('login — phase 2 (check progress)', () => {
  it('reports still-waiting while approval is pending', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart({ user_code: 'WXYZ-1234' }));
    await login({ baseUrl: BASE, clientName: 'c' });

    // No timers advanced yet — the background loop hasn't polled at all.
    const second = await login({ baseUrl: BASE, clientName: 'c' });
    expect(second.text).toMatch(/still waiting/i);
    expect(second.text).toContain('WXYZ-1234');
    // Calling login again must not start a second device-authorization flow.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('saves the credential and reports success once approved', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart({ device_code: 'dc_success' }));
    await login({ baseUrl: BASE, clientName: 'c' });

    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { api_key: 'bg_live_success', key_id: 'key_9', account_name: 'Radim', scopes: ['intakes:read'] }),
    );
    await vi.advanceTimersByTimeAsync(1100); // let the poll loop's first tick run

    const result = await login({ baseUrl: BASE, clientName: 'c' });
    expect(result.text).toMatch(/Signed in as Radim/);
    expect(result.text).toContain('key_9');
    expect(result.apiKey).toBe('bg_live_success');
    expect(loadCredential(BASE)?.api_key).toBe('bg_live_success');

    // The outcome is consumed once — asking again with nothing new in flight
    // starts a brand new flow rather than repeating the old result.
    vi.mocked(fetch).mockResolvedValueOnce(mockStart({ device_code: 'dc_next' }));
    await login({ baseUrl: BASE, clientName: 'c' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('doubles the poll interval on slow_down and honors it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());
    await login({ baseUrl: BASE, clientName: 'c' });

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(429, { error: 'slow_down' }));
    await vi.advanceTimersByTimeAsync(1100);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2); // start + first poll

    // Interval is now 2s — 1.5s more must not trigger a third poll yet.
    await vi.advanceTimersByTimeAsync(1500);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(428, { error: 'authorization_pending' }));
    await vi.advanceTimersByTimeAsync(600); // crosses the 2s mark
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it('reports a clear message when the code expired', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart({ expires_in: 1, interval: 1 }));
    await login({ baseUrl: BASE, clientName: 'c' });

    vi.mocked(fetch).mockResolvedValue(mockResponse(428, { error: 'authorization_pending' }));
    await vi.advanceTimersByTimeAsync(2000);

    const result = await login({ baseUrl: BASE, clientName: 'c' });
    expect(result.text).toMatch(/expired|timed out/i);
    expect(result.text).toMatch(/login.*again/i);
    expect(result.apiKey).toBeUndefined();
  });

  it('reports when the code was already used (consumed)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());
    await login({ baseUrl: BASE, clientName: 'c' });

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, { error: 'consumed' }));
    await vi.advanceTimersByTimeAsync(1100);

    const result = await login({ baseUrl: BASE, clientName: 'c' });
    expect(result.text).toMatch(/already (been )?used|consumed/i);
  });

  it('reports denial', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());
    await login({ baseUrl: BASE, clientName: 'c' });

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(403, { error: 'denied' }));
    await vi.advanceTimersByTimeAsync(1100);

    const result = await login({ baseUrl: BASE, clientName: 'c' });
    expect(result.text).toMatch(/denied/i);
    expect(result.apiKey).toBeUndefined();
  });

  it('keeps polling through a transient network error instead of failing the whole flow', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());
    await login({ baseUrl: BASE, clientName: 'c' });

    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNRESET'));
    await vi.advanceTimersByTimeAsync(1100);
    // Still waiting — the transient error did not settle the flow as a failure.
    const stillWaiting = await login({ baseUrl: BASE, clientName: 'c' });
    expect(stillWaiting.text).toMatch(/still waiting/i);

    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { api_key: 'bg_live_after_retry', key_id: 'k', account_name: 'A', scopes: [] }),
    );
    await vi.advanceTimersByTimeAsync(1100);
    const result = await login({ baseUrl: BASE, clientName: 'c' });
    expect(result.apiKey).toBe('bg_live_after_retry');
  });
});

describe('logout', () => {
  async function signIn(apiKey: string): Promise<void> {
    vi.mocked(fetch).mockResolvedValueOnce(mockStart());
    await login({ baseUrl: BASE, clientName: 'c' });
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { api_key: apiKey, key_id: 'k', account_name: 'A', scopes: [] }),
    );
    await vi.advanceTimersByTimeAsync(1100);
    await login({ baseUrl: BASE, clientName: 'c' }); // consume the outcome, persisting to file
  }

  it('says there is nothing to do when no credential is stored', async () => {
    expect(await logout(BASE)).toMatch(/nothing to do/i);
  });

  it('sends the stored key as the Bearer token to revoke it, then removes the local copy', async () => {
    await signIn('bg_live_z');
    expect(loadCredential(BASE)).toBeDefined();

    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(204, undefined));
    const message = await logout(BASE);

    const [url, init] = vi.mocked(fetch).mock.calls.at(-1) as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/keys/current`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bg_live_z');
    expect(message).toMatch(/signed out/i);
    expect(message).toMatch(/revoked/i);
    expect(loadCredential(BASE)).toBeUndefined();
  });

  it('treats a 401 from the revoke call as already revoked, not a failure', async () => {
    await signIn('bg_live_already_gone');
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(401, { message: 'invalid' }));
    const message = await logout(BASE);
    expect(message).toMatch(/signed out/i);
    expect(message).not.toMatch(/could not be revoked/i);
    expect(loadCredential(BASE)).toBeUndefined();
  });

  it('still removes the local credential when the revoke call fails, with a warning', async () => {
    await signIn('bg_live_network_fail');
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const message = await logout(BASE);
    expect(message).toMatch(/could not be revoked/i);
    expect(message).toMatch(/keys page/i);
    // Local removal must not depend on the network call succeeding.
    expect(loadCredential(BASE)).toBeUndefined();
  });
});
