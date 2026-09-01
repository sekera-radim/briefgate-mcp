import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  itemDefinitionSchema,
  itemKeySchema,
  callDefineIntake,
  callGetIntakeStatus,
  callGetIntakeResults,
  callRequestRevision,
  callSendChase,
  callListIntakes,
  callAddItems,
  callUpdateItem,
  callManageWebhook,
  type ToolResult,
} from '../src/tools.js';
import type { BriefGateConfig } from '../src/client.js';

const config: BriefGateConfig = {
  apiKey: 'bg_test_key',
  baseUrl: 'https://api.briefgate.dev',
};

function mockOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

// ─── itemKeySchema validation ─────────────────────────────────────────────────

describe('itemKeySchema', () => {
  it('accepts valid snake_case keys', () => {
    expect(itemKeySchema.safeParse('logo').success).toBe(true);
    expect(itemKeySchema.safeParse('hero_copy').success).toBe(true);
    expect(itemKeySchema.safeParse('ga4_id').success).toBe(true);
    expect(itemKeySchema.safeParse('a').success).toBe(true);
    expect(itemKeySchema.safeParse('logo2').success).toBe(true);
  });

  it('rejects keys with uppercase letters', () => {
    // "Logo" starts with uppercase — server would reject it and it would be
    // unusable as a property name in typed results
    expect(itemKeySchema.safeParse('Logo').success).toBe(false);
    expect(itemKeySchema.safeParse('heroText').success).toBe(false);
    expect(itemKeySchema.safeParse('LOGO').success).toBe(false);
  });

  it('rejects keys starting with a digit', () => {
    expect(itemKeySchema.safeParse('1logo').success).toBe(false);
  });

  it('rejects keys with spaces or hyphens', () => {
    expect(itemKeySchema.safeParse('hero copy').success).toBe(false);
    expect(itemKeySchema.safeParse('hero-copy').success).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(itemKeySchema.safeParse('').success).toBe(false);
  });
});

// ─── itemDefinitionSchema: cross-field validation ─────────────────────────────

describe('itemDefinitionSchema', () => {
  it('accepts a valid text item', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'ga4_id',
      type: 'text',
      label: 'Google Analytics ID',
      pattern: '^G-[A-Z0-9]+$',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid image item with constraints', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'logo',
      type: 'image',
      label: 'Company logo',
      constraints: { formats: ['svg', 'png'], min_width: 512 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects type=select without options (select requires non-empty options[])', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'tier',
      type: 'select',
      label: 'Service tier',
    });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((i) => /options/.test(i.message))).toBe(true);
  });

  it('rejects type=select with empty options array', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'tier',
      type: 'select',
      label: 'Service tier',
      options: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts type=select with non-empty options', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'tier',
      type: 'select',
      label: 'Service tier',
      options: [
        { value: 'basic', label: 'Basic' },
        { value: 'pro', label: 'Pro' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects type=structured without schema', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'opening_hours',
      type: 'structured',
      label: 'Opening hours',
    });
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.some((i) => /schema/.test(i.message))).toBe(true);
  });

  it('accepts type=structured with a JSON Schema', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'opening_hours',
      type: 'structured',
      label: 'Opening hours',
      schema: {
        type: 'object',
        properties: { mon_fri: { type: 'string' }, sat: { type: 'string' } },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a secret item with uppercase key "Logo"', () => {
    const result = itemDefinitionSchema.safeParse({
      key: 'Logo',
      type: 'image',
      label: 'Logo',
    });
    expect(result.success).toBe(false);
  });
});

// ─── callDefineIntake: correct endpoint and body ──────────────────────────────

describe('callDefineIntake', () => {
  it('calls POST /v1/intakes with correct body and returns intake_id', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] }),
    );

    const result: ToolResult = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.text) as Record<string, unknown>;
    expect(parsed['intake_id']).toBe('in_1');
    expect(parsed['portal_url']).toBeDefined();

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes');
    expect(init.method).toBe('POST');
    // Idempotency-Key must be present to protect against agent retry loops
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeDefined();
  });

  it('returns validation error for missing required fields', async () => {
    const result = await callDefineIntake(config, { project_name: 'Test' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Validation error/);
  });

  // Zod strips unknown keys by default, so a mistyped parameter used to vanish
  // silently: `send_now` (the field is `send`) was dropped and the invite went
  // out anyway. The API answers 422 for the same body — failing here reports it
  // before the request leaves, naming the key.
  it('rejects an unknown parameter instead of silently dropping it', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      send_now: false,
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/send_now/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // The API rejects a nameless client, and an agent that hits that only sees an
  // opaque 422 after the request has already gone out. Failing here instead
  // names the field to fill in, and never touches the network.
  it('rejects a client with no name before calling the API', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/name/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  // The chase cadence is the product's whole point, so the tool must pass the
  // custom interval through rather than quietly dropping an unknown field.
  it('forwards a custom cadence, its unit and the cap to the API', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_2', portal_url: 'https://p.briefgate.dev/2', status: 'sent', items: [] }),
    );

    await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      chase_schedule: 'custom',
      chase_interval: 5,
      chase_interval_unit: 'minutes',
      respect_quiet_hours: false,
      max_reminders: 20,
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['chase_schedule']).toBe('custom');
    expect(body['chase_interval']).toBe(5);
    expect(body['chase_interval_unit']).toBe('minutes');
    expect(body['respect_quiet_hours']).toBe(false);
    expect(body['max_reminders']).toBe(20);
  });

  it('accepts chase_schedule "custom" alone (the server defaults it to every 3 days)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_3', portal_url: 'https://p.briefgate.dev/3', status: 'sent', items: [] }),
    );

    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      chase_schedule: 'custom',
    });

    expect(result.isError).toBeFalsy();
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['chase_interval']).toBeUndefined();
  });

  it.each([0, -1, 2.5])('rejects a non-positive chase_interval (%s)', async bad => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      chase_schedule: 'custom',
      chase_interval: bad,
      chase_interval_unit: 'minutes',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Validation error/);
  });

  it('rejects an unknown chase_interval_unit', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      chase_schedule: 'custom',
      chase_interval: 2,
      chase_interval_unit: 'fortnights',
    });
    expect(result.isError).toBe(true);
  });

  it.each([0, -1, 1001, 2.5])('rejects an invalid max_reminders (%s)', async bad => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      max_reminders: bad,
    });
    expect(result.isError).toBe(true);
  });

  it('rejects an unknown chase_schedule', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      chase_schedule: 'nag_hourly',
    });
    expect(result.isError).toBe(true);
  });

  it('returns validation error when items contain select without options', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test',
      client: { email: 'c@e.com', name: 'Jana Nováková' },
      items: [{ key: 'tier', type: 'select', label: 'Tier' }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/options/);
  });

  it('returns validation error when item key is "Logo" (uppercase)', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test',
      client: { email: 'c@e.com', name: 'Jana Nováková' },
      items: [{ key: 'Logo', type: 'image', label: 'Company logo' }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Validation error/);
  });

  it('derives a stable idempotency key (same args → same key)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] }),
      )
      .mockResolvedValueOnce(
        mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] }),
      );

    const args = {
      project_name: 'Same Project',
      client: { email: 'same@client.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image' as const, label: 'Logo' }],
    };

    await callDefineIntake(config, args);
    await callDefineIntake(config, args);

    const key1 = (vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const key2 = (vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(key1['Idempotency-Key']).toBe(key2['Idempotency-Key']);
  });

  it('derives different idempotency keys when items differ (prevents collision for new project same client)', async () => {
    // Two separate intakes: same project_name + client but different items (e.g. a new project
    // scope a year later). They must NOT share an idempotency key or the second will be rejected
    // as a duplicate by the server and the client never gets an invite.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] }),
      )
      .mockResolvedValueOnce(
        mockOk({ intake_id: 'in_2', portal_url: 'https://p.briefgate.dev/2', status: 'sent', items: [] }),
      );

    const baseArgs = { project_name: 'Web', client: { email: 'client@firma.cz', name: 'Jana Nováková' } };

    await callDefineIntake(config, {
      ...baseArgs,
      items: [{ key: 'logo', type: 'image' as const, label: 'Logo' }],
    });
    await callDefineIntake(config, {
      ...baseArgs,
      items: [{ key: 'logo', type: 'image' as const, label: 'Logo' }, { key: 'hero_copy', type: 'text' as const, label: 'Hero copy' }],
    });

    const key1 = (vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const key2 = (vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(key1['Idempotency-Key']).not.toBe(key2['Idempotency-Key']);
  });

  it('idempotency key is stable regardless of items array order', async () => {
    // Items provided in different order should hash to the same key so that
    // an agent reordering the array does not accidentally bypass deduplication.
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] }),
      )
      .mockResolvedValueOnce(
        mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'sent', items: [] }),
      );

    const baseArgs = { project_name: 'Web', client: { email: 'client@firma.cz', name: 'Jana Nováková' } };

    await callDefineIntake(config, {
      ...baseArgs,
      items: [
        { key: 'logo', type: 'image' as const, label: 'Logo' },
        { key: 'hero_copy', type: 'text' as const, label: 'Hero copy' },
      ],
    });
    await callDefineIntake(config, {
      ...baseArgs,
      items: [
        { key: 'hero_copy', type: 'text' as const, label: 'Hero copy' },
        { key: 'logo', type: 'image' as const, label: 'Logo' },
      ],
    });

    const key1 = (vi.mocked(fetch).mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    const key2 = (vi.mocked(fetch).mock.calls[1] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(key1['Idempotency-Key']).toBe(key2['Idempotency-Key']);
  });
});

// ─── callGetIntakeStatus ──────────────────────────────────────────────────────

describe('callGetIntakeStatus', () => {
  it('calls GET /v1/intakes/:id/status', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_1', status: 'in_progress', progress: { submitted: 1, total: 3 }, items: [], chases: [] }),
    );

    const result = await callGetIntakeStatus(config, { intake_id: 'in_1' });

    expect(result.isError).toBeFalsy();
    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/v1/intakes/in_1/status');
  });

  it('returns validation error for missing intake_id', async () => {
    const result = await callGetIntakeStatus(config, {});
    expect(result.isError).toBe(true);
  });
});

// ─── callGetIntakeResults ─────────────────────────────────────────────────────

describe('callGetIntakeResults', () => {
  it('calls GET /v1/intakes/:id/results', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_1', status: 'completed', results: { logo: 'https://signed.url/logo.png' }, meta: {} }),
    );

    const result = await callGetIntakeResults(config, { intake_id: 'in_1', only_new: true });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/v1/intakes/in_1/results');
    expect(url).toContain('only_new=true');
    expect(result.isError).toBeFalsy();
  });
});

// ─── callRequestRevision ──────────────────────────────────────────────────────

describe('callRequestRevision', () => {
  it('calls POST /v1/intakes/:id/revision', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ status: 'revision_requested', item_key: 'logo' }),
    );

    const result = await callRequestRevision(config, {
      intake_id: 'in_1',
      item_key: 'logo',
      note: 'Logo is blurry, minimum 512px PNG or SVG required',
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes/in_1/revision');
    expect(init.method).toBe('POST');
    expect(result.isError).toBeFalsy();
  });
});

// ─── callSendChase ────────────────────────────────────────────────────────────

describe('callSendChase', () => {
  it('calls POST /v1/intakes/:id/chase', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ sent: true }));

    const result = await callSendChase(config, { intake_id: 'in_1', channel: 'email' });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/v1/intakes/in_1/chase');
    expect(result.isError).toBeFalsy();
  });
});

// ─── callListIntakes ──────────────────────────────────────────────────────────

describe('callListIntakes', () => {
  it('calls GET /v1/intakes with filters', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ intakes: [], total: 0 }));

    await callListIntakes(config, { status: 'completed', limit: 5 });

    const [url] = vi.mocked(fetch).mock.calls[0] as [string];
    expect(url).toContain('/v1/intakes');
    expect(url).toContain('status=completed');
    expect(url).toContain('limit=5');
  });

  it('works with no filters', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ intakes: [], total: 0 }));

    const result = await callListIntakes(config, {});
    expect(result.isError).toBeFalsy();
  });
});

// ─── callAddItems ─────────────────────────────────────────────────────────────

describe('callAddItems', () => {
  it('calls POST /v1/intakes/:id/items', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_1', portal_url: 'https://p.briefgate.dev/1', status: 'in_progress', items: [] }),
    );

    const result = await callAddItems(config, {
      intake_id: 'in_1',
      items: [{ key: 'favicon', type: 'image', label: 'Favicon' }],
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes/in_1/items');
    expect(init.method).toBe('POST');
    expect(result.isError).toBeFalsy();
  });

  it('returns validation error for structured item without schema', async () => {
    const result = await callAddItems(config, {
      intake_id: 'in_1',
      items: [{ key: 'opening_hours', type: 'structured', label: 'Opening hours' }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/schema/);
  });
});

// ─── callUpdateItem ───────────────────────────────────────────────────────────

// The situation: you asked for an image and the client only has the logo as a
// PDF. Widening the item is what unblocks them, so the tool has to reach the
// right endpoint and refuse the changes that would leave the item unusable.
describe('callUpdateItem', () => {
  it('PATCHes the single item, not the intake', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ item: { key: 'logo', type: 'file' } }));

    const result = await callUpdateItem(config, {
      intake_id: 'in_1',
      item_key: 'logo',
      type: 'file',
      constraints: { formats: ['svg', 'png', 'pdf'] },
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/intakes/in_1/items/logo');
    expect(init.method).toBe('PATCH');
    expect(result.isError).toBeFalsy();
  });

  // The key and the id address the item; sending them as changes would ask the
  // server to rename it, which it refuses.
  it('sends only the changed fields, not the addressing ones', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ item: { key: 'logo' } }));

    await callUpdateItem(config, { intake_id: 'in_1', item_key: 'logo', label: 'Logo firmy' });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toEqual({ label: 'Logo firmy' });
  });

  it('refuses a call that changes nothing', async () => {
    const result = await callUpdateItem(config, { intake_id: 'in_1', item_key: 'logo' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at least one field/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('will not rename the key', async () => {
    const result = await callUpdateItem(config, { intake_id: 'in_1', item_key: 'logo', key: 'brand_logo' });
    expect(result.isError).toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('passes the discard flag through once the caller opts in', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockOk({ item: { key: 'logo' }, discarded_submitted_value: true }));

    await callUpdateItem(config, {
      intake_id: 'in_1',
      item_key: 'logo',
      type: 'file',
      discard_submitted_value: true,
    });

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ discard_submitted_value: true });
  });
});

// ─── cadence notices: what a fast cadence quietly implies ─────────────────────

describe('callDefineIntake — cadence notices', () => {
  function ok() {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockOk({ intake_id: 'in_n', portal_url: 'https://p.briefgate.dev/n', status: 'sent', items: [] }),
    );
  }

  async function notices(extra: Record<string, unknown>): Promise<string[]> {
    ok();
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      ...extra,
    });
    expect(result.isError).toBeFalsy();
    return (JSON.parse(result.text) as { notices?: string[] }).notices ?? [];
  }

  it('warns about the 3-reminder cap for an hourly cadence', async () => {
    const n = await notices({ chase_schedule: 'custom', chase_interval: 1, chase_interval_unit: 'hours' });
    expect(n.join(' ')).toMatch(/max_reminders/);
    expect(n.join(' ')).toMatch(/unlimited/);
  });

  it('warns that quiet hours will pause an hourly cadence overnight', async () => {
    const n = await notices({ chase_schedule: 'custom', chase_interval: 1, chase_interval_unit: 'hours' });
    expect(n.join(' ')).toMatch(/respect_quiet_hours/);
    expect(n.join(' ')).toMatch(/08:00/);
  });

  // Nothing to warn about once the caller has already decided.
  it('stays quiet when the caller set both explicitly', async () => {
    const n = await notices({
      chase_schedule: 'custom',
      chase_interval: 1,
      chase_interval_unit: 'hours',
      max_reminders: 'unlimited',
      respect_quiet_hours: false,
    });
    expect(n).toEqual([]);
  });

  it('says nothing for a daily or longer cadence', async () => {
    expect(await notices({ chase_schedule: 'custom', chase_interval: 2, chase_interval_unit: 'days' })).toEqual([]);
    expect(await notices({ chase_schedule: 'default' })).toEqual([]);
  });

  it('explains that an explicit time overrides quiet hours', async () => {
    const n = await notices({ chase_schedule: 'custom', chase_at_time: '07:00' });
    expect(n.join(' ')).toMatch(/07:00/);
    expect(n.join(' ')).toMatch(/overrides quiet hours/);
  });

  it('accepts "unlimited" and forwards it to the API', async () => {
    ok();
    await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      max_reminders: 'unlimited',
    });
    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((JSON.parse(init.body as string) as Record<string, unknown>)['max_reminders']).toBe('unlimited');
  });

  it('rejects a max_reminders string that is not "unlimited"', async () => {
    const result = await callDefineIntake(config, {
      project_name: 'Test Project',
      client: { email: 'client@example.com', name: 'Jana Nováková' },
      items: [{ key: 'logo', type: 'image', label: 'Logo' }],
      max_reminders: 'forever',
    });
    expect(result.isError).toBe(true);
  });
});

// ─── manage_webhook ───────────────────────────────────────────────────────────
//
// The REST routes accepted an API key from the start, but no MCP tool reached
// them, so an agent could verify an incoming webhook and never register one.

describe('callManageWebhook', () => {
  it('creates an endpoint and tells the caller to store the secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockOk({ id: 'whe_1', url: 'https://x.dev/h', events: ['intake.completed'], secret: 'whsec_abc' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await callManageWebhook(config, {
      action: 'create',
      url: 'https://x.dev/h',
      events: ['intake.completed'],
    });

    expect(res.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/webhooks');
    expect(init.method).toBe('POST');
    // The secret is returned exactly once, so the reply has to say so — an
    // agent that treats it as retrievable loses it.
    expect(res.text).toContain('whsec_abc');
    expect(res.text).toMatch(/only on creation/i);
  });

  it('lists endpoints without needing any other argument', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockOk({ webhooks: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callManageWebhook(config, { action: 'list' });
    expect(res.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('https://api.briefgate.dev/v1/webhooks');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('deletes by id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockOk({ deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callManageWebhook(config, { action: 'delete', webhook_id: 'whe_1' });
    expect(res.isError).toBeFalsy();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.briefgate.dev/v1/webhooks/whe_1');
    expect(init.method).toBe('DELETE');
  });

  it('refuses create without url or events, naming the action', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const noUrl = await callManageWebhook(config, { action: 'create', events: ['intake.completed'] });
    const noEvents = await callManageWebhook(config, { action: 'create', url: 'https://x.dev/h' });

    expect(noUrl.isError).toBe(true);
    expect(noEvents.isError).toBe(true);
    expect(noUrl.text).toContain('create');
    // Nothing may reach the API on a request that cannot succeed.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses delete without an id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await callManageWebhook(config, { action: 'delete' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('webhook_id');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown event rather than passing it through', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await callManageWebhook(config, {
      action: 'create',
      url: 'https://x.dev/h',
      events: ['intake.finished'],
    });
    expect(res.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── decisions ────────────────────────────────────────────────────────────────
//
// An agent must be able to pose a question it cannot answer and keep working.
// What these hold onto is that a proposal is only ever accepted where it can
// actually mean something — otherwise it is a value going nowhere.

describe('decision items', () => {
  const priceDecision = (extra: Record<string, unknown> = {}) => ({
    key: 'discount_price',
    type: 'select',
    assignee: 'owner',
    label: 'What does the discounted subscription cost?',
    options: [
      { value: '19', label: '$19/month' },
      { value: '29', label: '$29/month' },
    ],
    ...extra,
  });

  const define = (item: Record<string, unknown>) =>
    callDefineIntake(config, {
      project_name: 'P',
      client: { email: 'c@example.com', name: 'Petr' },
      items: [item],
    });

  it('accepts a proposal on an owner select', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockOk({ intake_id: 'in_1', portal_url: 'u', status: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await define(priceDecision({ proposed: { value: '19', rationale: 'benchmark' } }));
    expect(res.isError).toBeFalsy();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { items: Record<string, unknown>[] };
    expect(sent.items[0]!['proposed']).toEqual({ value: '19', rationale: 'benchmark' });
  });

  it('accepts multiselect with an array proposal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockOk({ intake_id: 'in_1', portal_url: 'u', status: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await define(
      priceDecision({ type: 'multiselect', proposed: { value: ['19', '29'] }, constraints: { max_count: 2 } }),
    );
    expect(res.isError).toBeFalsy();
  });

  it('refuses a proposal on a client item before it reaches the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await define(priceDecision({ assignee: 'client', proposed: { value: '19' } }));
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/assignee=owner/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a proposal on a type with no options', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await define({
      key: 'note',
      type: 'text',
      assignee: 'owner',
      label: 'Note',
      proposed: { value: 'x' },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/select or type=multiselect/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires options on a multiselect', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await define({ key: 'langs', type: 'multiselect', label: 'Languages' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/non-empty options/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
