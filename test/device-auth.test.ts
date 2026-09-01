import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startDeviceAuth, pollDeviceAuth, revokeCurrentKey } from '../src/device-auth.js';

const BASE = 'https://api.briefgate.dev';

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { status, json: async () => body, headers: new Headers(headers) } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('startDeviceAuth', () => {
  it('POSTs client_name with no Authorization header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, {
        device_code: 'dc_1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://briefgate.dev/device',
        verification_uri_complete: 'https://briefgate.dev/device?code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      }),
    );

    const result = await startDeviceAuth(BASE, 'Claude Code on radim-pc');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/auth/device/start`);
    expect(JSON.parse(init.body as string)).toEqual({ client_name: 'Claude Code on radim-pc' });
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(result.user_code).toBe('ABCD-EFGH');
  });

  it('includes scopes when provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, {}));
    await startDeviceAuth(BASE, 'client', ['intakes:read']);
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ client_name: 'client', scopes: ['intakes:read'] });
  });

  it('throws a readable error on a non-200 response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(500, { message: 'boom' }));
    await expect(startDeviceAuth(BASE, 'client')).rejects.toThrow(/Could not start sign-in: boom/);
  });
});

describe('pollDeviceAuth', () => {
  it('returns success with the issued key on 200', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { api_key: 'bg_live_x', key_id: 'key_1', account_name: 'Radim', scopes: ['intakes:read'] }),
    );
    const outcome = await pollDeviceAuth(BASE, 'dc_1');
    expect(outcome).toEqual({
      status: 'success',
      result: { api_key: 'bg_live_x', key_id: 'key_1', account_name: 'Radim', scopes: ['intakes:read'] },
    });
  });

  it('sends device_code with no Authorization header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(428, { error: 'authorization_pending' }));
    await pollDeviceAuth(BASE, 'dc_42');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/auth/device/poll`);
    expect(JSON.parse(init.body as string)).toEqual({ device_code: 'dc_42' });
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('maps 428 authorization_pending to pending', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(428, { error: 'authorization_pending' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'pending' });
  });

  it('maps 429 slow_down to slow_down, with no Retry-After', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(429, { reason: 'slow_down' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'slow_down' });
  });

  it('carries the Retry-After seconds when the server sends one', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(429, { reason: 'slow_down' }, { 'Retry-After': '10' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'slow_down', retryAfterSeconds: 10 });
  });

  it('maps 410 device_code_expired to expired', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, { reason: 'device_code_expired' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'expired' });
  });

  it('maps 410 device_code_consumed to consumed, distinct from expired', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, { reason: 'device_code_consumed' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'consumed' });
  });

  it('still recognizes the older bare "expired"/"consumed" reason values', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, { error: 'consumed' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'consumed' });
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, { error: 'expired' }));
    expect(await pollDeviceAuth(BASE, 'dc_2')).toEqual({ status: 'expired' });
  });

  it('defaults an unlabeled 410 to expired', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, {}));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'expired' });
  });

  it('maps 403 device_denied to denied', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(403, { reason: 'device_denied' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'denied' });
  });

  it('maps 404 device_code_unknown to unknown_code', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(404, { reason: 'device_code_unknown' }));
    expect(await pollDeviceAuth(BASE, 'dc_1')).toEqual({ status: 'unknown_code' });
  });

  it('throws on an unrecognized error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(500, { message: 'server exploded' }));
    await expect(pollDeviceAuth(BASE, 'dc_1')).rejects.toThrow(/server exploded/);
  });
});

describe('revokeCurrentKey', () => {
  it('sends the key itself as the Bearer token, and reports "revoked" on 204', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(204, undefined));
    const outcome = await revokeCurrentKey(BASE, 'bg_live_x');
    expect(outcome).toBe('revoked');
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/v1/keys/current`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bg_live_x');
  });

  it('reports "already_revoked" on 401 rather than treating it as a failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(401, { message: 'invalid' }));
    expect(await revokeCurrentKey(BASE, 'bg_live_x')).toBe('already_revoked');
  });

  it('reports "failed" on an unexpected status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(500, {}));
    expect(await revokeCurrentKey(BASE, 'bg_live_x')).toBe('failed');
  });

  it('reports "failed" rather than throwing on a network error', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await revokeCurrentKey(BASE, 'bg_live_x')).toBe('failed');
  });
});
