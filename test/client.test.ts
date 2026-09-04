import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  apiRequest,
  createIntake,
  getIntakeStatus,
  getIntakeResults,
  listIntakes,
  sendChase,
  requestRevision,
  addItems,
  updateIntake,
  addRecipient,
  removeRecipient,
  reinstateRecipient,
  listFolders,
  createFolder,
  type BriefGateConfig,
} from '../src/client.js';

const config: BriefGateConfig = {
  apiKey: 'bg_test_key',
  baseUrl: 'https://api.briefgate.dev',
};

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    headers: new Headers(headers),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── apiRequest: sends correct headers ───────────────────────────────────────

describe('apiRequest', () => {
  it('sends Authorization header and JSON body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { ok: true }));

    await apiRequest(config, 'POST', '/intakes', { project_name: 'Test' });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer bg_test_key');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ project_name: 'Test' }));
  });

  it('sends extra headers when provided', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, {}));

    await apiRequest(config, 'POST', '/intakes', {}, { 'Idempotency-Key': 'abc123' });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('abc123');
  });

  it('returns empty object for 204 No Content', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 204,
      json: async () => { throw new Error('no body'); },
      headers: new Headers(),
    } as unknown as Response);

    const result = await apiRequest(config, 'DELETE', '/intakes/in_1');
    expect(result).toEqual({});
  });
});

// ─── Error mapping ────────────────────────────────────────────────────────────

describe('error mapping', () => {
  it('401 → verify your API key', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(401, { message: 'Unauthorized' }));
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(
      /verify your BRIEFGATE_API_KEY/,
    );
  });

  it('402 → plan limit reached with server message', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(402, { message: 'Active intake limit reached (Free: 1)' }),
    );
    await expect(apiRequest(config, 'POST', '/intakes', {})).rejects.toThrow(
      /Plan limit reached.*Active intake limit reached/,
    );
  });

  it('403 → scope error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(403, { message: 'Forbidden' }));
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(/required scope/);
  });

  it('404 → resource not found', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(404, { message: 'Not found' }));
    await expect(getIntakeStatus(config, 'in_missing')).rejects.toThrow(/not found/);
  });

  it('409 → conflict with idempotency key', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(409, { message: 'Conflict' }));
    await expect(apiRequest(config, 'POST', '/intakes', {})).rejects.toThrow(
      /idempotency key already exists/,
    );
  });

  it('410 → deleted intake', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(410, { message: 'Gone' }));
    await expect(getIntakeStatus(config, 'in_deleted')).rejects.toThrow(/deleted/);
  });

  it('429 → rate limited with Retry-After header', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(429, { message: 'Too many requests' }, { 'Retry-After': '30' }),
    );
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(
      /Rate limited.*30s.*webhooks/,
    );
  });

  it('429 → rate limited without Retry-After falls back gracefully', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(429, { message: 'Too many requests' }));
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(/Rate limited/);
  });

  it('500 → internal server error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(500, { message: 'Internal error' }));
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(/API error 500/);
  });

  it('418 (unknown status) → readable error with status code', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(418, { message: "I'm a teapot" }));
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(/418/);
  });
});

// ─── Timeout ──────────────────────────────────────────────────────────────────

describe('fetch timeout', () => {
  it('throws a readable timeout error when fetch hangs for 30s', async () => {
    // The mock must honour the AbortSignal so that when client.ts fires
    // controller.abort() after 30 s, the Promise rejects with AbortError.
    // Derive the input type from the global fetch rather than naming a DOM type:
    // this package compiles with lib: ES2022 (no DOM), where `RequestInfo` does
    // not exist — @types/node only declares `RequestInit`, `Response` and friends.
    vi.mocked(fetch).mockImplementationOnce(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );

    const requestPromise = apiRequest(config, 'GET', '/intakes');

    // Attach the rejection handler BEFORE advancing timers so that Node.js
    // never sees an unhandled rejection during the window between abort firing
    // and the assertion executing.
    const assertion = expect(requestPromise).rejects.toThrow(/timed out after 30s/);

    // Advance fake timers past the 30-second abort threshold; microtasks settle.
    await vi.advanceTimersByTimeAsync(31_000);

    await assertion;
  }, 10_000);

  it('throws a readable error on network failure (ECONNREFUSED)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), { code: 'ECONNREFUSED' }),
    );
    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(
      /BriefGate API unreachable.*ECONNREFUSED/,
    );
  });
});

// ─── Non-JSON response ────────────────────────────────────────────────────────

describe('non-JSON response handling', () => {
  it('throws a readable error when a 200 response contains HTML (proxy/CDN wrapping)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
      headers: new Headers(),
    } as unknown as Response);

    await expect(apiRequest(config, 'GET', '/intakes')).rejects.toThrow(
      /unexpected non-JSON response/,
    );
  });
});

// ─── Typed endpoint wrappers ──────────────────────────────────────────────────

describe('createIntake', () => {
  it('sends POST /v1/intakes with Idempotency-Key and returns intake', async () => {
    const intake = { intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] };
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, intake));

    const result = await createIntake(config, { project_name: 'Test' }, 'idem-key-123');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe('idem-key-123');
    expect(result.intake_id).toBe('in_1');
  });
});

describe('listIntakes', () => {
  it('sends GET /v1/intakes with query params', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { intakes: [], total: 0 }));

    await listIntakes(config, { status: 'in_progress', limit: 10 });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes');
    expect(url).toContain('status=in_progress');
    expect(url).toContain('limit=10');
  });

  it('sends folder_id and q as query params', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { intakes: [], total: 0 }));

    await listIntakes(config, { folder_id: 'none', q: 'kramolíšová' });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('folder_id=none');
    expect(url).toContain('q=');
  });
});

describe('folders', () => {
  it('listFolders sends GET /v1/folders', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { folders: [] }));

    await listFolders(config);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('https://api.briefgate.dev/v1/folders');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('createFolder sends POST /v1/folders with the name', async () => {
    const folder = { id: 'fld_1', name: 'Acme Inc', sort_order: 0, intake_count: 0, created_at: '2026-09-04T00:00:00Z' };
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(201, folder));

    const result = await createFolder(config, 'Acme Inc');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/folders');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Acme Inc' });
    expect(result.id).toBe('fld_1');
  });

  // The generic 409 wording ("an intake with this idempotency key already
  // exists") is about intake creation and would be actively misleading here.
  it('createFolder: 409 → folder_exists message naming the folder, not the generic idempotency-key text', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(409, { error: 'folder_exists' }));

    await expect(createFolder(config, 'Acme Inc')).rejects.toThrow(/Acme Inc.*already exists/i);
    await expect(createFolder(config, 'Acme Inc')).rejects.not.toThrow(/idempotency/i);
  });
});

describe('getIntakeStatus', () => {
  it('sends GET /v1/intakes/:id/status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { intake_id: 'in_1', status: 'in_progress', progress: { submitted: 2, total: 5 }, items: [], chases: [] }),
    );

    await getIntakeStatus(config, 'in_1');

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/status');
  });
});

describe('getIntakeResults', () => {
  it('sends GET /v1/intakes/:id/results with only_new flag', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { intake_id: 'in_1', status: 'completed', results: {}, meta: {} }),
    );

    await getIntakeResults(config, 'in_1', { only_new: true });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes/in_1/results');
    expect(url).toContain('only_new=true');
  });
});

describe('addItems', () => {
  it('sends POST /v1/intakes/:id/items with items array', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'in_progress', items: [] }),
    );

    const items = [{ key: 'favicon', type: 'image' as const, label: 'Favicon' }];
    await addItems(config, 'in_1', items);

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/items');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { items: typeof items };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].key).toBe('favicon');
  });
});

describe('updateIntake', () => {
  it('sends PATCH /v1/intakes/:id with the given changes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { intake_id: 'in_1', status: 'sent' }));

    await updateIntake(config, 'in_1', { due_date: '2026-12-01', chase_schedule: 'gentle' });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ due_date: '2026-12-01', chase_schedule: 'gentle' });
  });

  // The generic 409 wording ("an intake with this idempotency key already
  // exists") is about intake creation and would be actively misleading here —
  // this route's only 409 is an archived intake.
  it('409 → archived-intake message, not the generic idempotency-key text', async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse(409, { error: 'intake_archived' }));

    await expect(updateIntake(config, 'in_1', { project_name: 'New name' })).rejects.toThrow(/archived/i);
    await expect(updateIntake(config, 'in_1', { project_name: 'New name' })).rejects.not.toThrow(
      /idempotency/i,
    );
  });
});

describe('recipients', () => {
  it('addRecipient sends POST /v1/intakes/:id/recipients with email and name', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { email: 'extra@example.com' }));

    await addRecipient(config, 'in_1', { email: 'extra@example.com', name: 'Petr' });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/recipients');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'extra@example.com', name: 'Petr' });
  });

  it('removeRecipient sends DELETE /v1/intakes/:id/recipients/:email, URL-encoded', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(204, {}));

    await removeRecipient(config, 'in_1', 'extra+test@example.com');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/recipients/extra%2Btest%40example.com');
    expect(init.method).toBe('DELETE');
  });

  describe('reinstateRecipient', () => {
    it('sends POST /v1/intakes/:id/recipients/:email/reinstate', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(
        mockResponse(200, { email: 'extra@example.com', bounced_at: null, still_chasing: true }),
      );

      const result = await reinstateRecipient(config, 'in_1', 'extra@example.com');

      const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/recipients/extra%40example.com/reinstate');
      expect(init.method).toBe('POST');
      expect(result).toEqual({ email: 'extra@example.com', bounced_at: null, still_chasing: true });
    });

    // Same reasoning as updateIntake's 409 above: the generic 404/409 text is
    // written for the intake-level routes and would misdescribe an address
    // problem as an intake problem.
    it('404 → names the address, not "verify the intake_id"', async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse(404, { error: 'recipient_not_found' }));

      await expect(reinstateRecipient(config, 'in_1', 'ghost@example.com')).rejects.toThrow(
        /ghost@example\.com/,
      );
      await expect(reinstateRecipient(config, 'in_1', 'ghost@example.com')).rejects.not.toThrow(
        /intake_id/i,
      );
    });

    it('409 → "has not bounced", not the generic idempotency-key text', async () => {
      vi.mocked(fetch).mockResolvedValue(mockResponse(409, { error: 'recipient_not_bounced' }));

      await expect(reinstateRecipient(config, 'in_1', 'fine@example.com')).rejects.toThrow(
        /has not bounced/i,
      );
      await expect(reinstateRecipient(config, 'in_1', 'fine@example.com')).rejects.not.toThrow(
        /idempotency/i,
      );
    });
  });
});

describe('requestRevision', () => {
  it('sends POST /v1/intakes/:id/revision with item_key and note', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse(200, { status: 'revision_requested', item_key: 'logo' }),
    );

    await requestRevision(config, 'in_1', 'logo', 'Logo is blurry, minimum 512px');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/revision');
    const body = JSON.parse(init.body as string) as { item_key: string; note: string };
    expect(body.item_key).toBe('logo');
    expect(body.note).toBe('Logo is blurry, minimum 512px');
  });
});

describe('sendChase', () => {
  it('sends POST /v1/intakes/:id/chase without channel (default email)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { sent: true }));

    await sendChase(config, 'in_1');

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/intakes/in_1/chase');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['channel']).toBeUndefined();
  });

  it('sends channel=sms when specified', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockResponse(200, { sent: true }));

    await sendChase(config, 'in_1', 'sms');

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['channel']).toBe('sms');
  });
});
