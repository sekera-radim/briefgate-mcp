/**
 * tools.ts's own responsibility around login/logout: the apiKeySource gate
 * (an explicit key always wins, so login should say so instead of running
 * the device flow) and updating the shared config object in place once
 * login succeeds. The device-authorization flow itself is covered in
 * login.test.ts — mocked out here so these tests isolate tools.ts's logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/login.js', () => ({
  login: vi.fn(),
  logout: vi.fn(),
}));

import { executeTool } from '../src/tools.js';
import { login, logout } from '../src/login.js';
import type { BriefGateConfig } from '../src/client.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function config(overrides: Partial<BriefGateConfig> = {}): BriefGateConfig {
  return { apiKey: '', baseUrl: 'https://api.briefgate.dev', apiKeySource: 'none', ...overrides };
}

describe('login tool — already-configured gate', () => {
  it.each([
    ['flag', '--api-key'],
    ['env', 'BRIEFGATE_API_KEY'],
    ['header', 'Authorization header'],
  ] as const)('says so instead of running the flow when the key came from %s', async (source, mention) => {
    const cfg = config({ apiKey: 'bg_live_x', apiKeySource: source });
    const result = await executeTool('login', cfg, {});
    expect(result.text).toContain(mention);
    expect(vi.mocked(login)).not.toHaveBeenCalled();
  });

  it('runs the device flow when no key source overrides it', async () => {
    vi.mocked(login).mockResolvedValueOnce({ text: 'Open https://briefgate.dev/device and confirm code AAAA-BBBB.' });
    const cfg = config({ apiKeySource: 'none' });
    const result = await executeTool('login', cfg, {}, { clientName: 'Claude Code' });
    expect(vi.mocked(login)).toHaveBeenCalledWith({
      baseUrl: 'https://api.briefgate.dev',
      clientName: expect.stringContaining('Claude Code'),
    });
    expect(result.text).toContain('AAAA-BBBB');
  });

  it('runs the flow again for a stored ("file") key — that source does not block it', async () => {
    vi.mocked(login).mockResolvedValueOnce({ text: 'still waiting' });
    const cfg = config({ apiKey: 'bg_live_old', apiKeySource: 'file' });
    await executeTool('login', cfg, {});
    expect(vi.mocked(login)).toHaveBeenCalled();
  });

  it('falls back to a generic client name when initialize sent none', async () => {
    vi.mocked(login).mockResolvedValueOnce({ text: 'ok' });
    await executeTool('login', config(), {});
    const call = vi.mocked(login).mock.calls[0]?.[0];
    expect(call?.clientName).toMatch(/^MCP client on /);
  });
});

describe('login tool — updates config on success', () => {
  it('mutates the shared config object so the next call is signed in immediately', async () => {
    vi.mocked(login).mockResolvedValueOnce({ text: 'Signed in as Radim.', apiKey: 'bg_live_new' });
    const cfg = config();
    await executeTool('login', cfg, {});
    expect(cfg.apiKey).toBe('bg_live_new');
    expect(cfg.apiKeySource).toBe('file');
  });

  it('leaves config untouched while still waiting for approval', async () => {
    vi.mocked(login).mockResolvedValueOnce({ text: 'Still waiting for approval.' });
    const cfg = config();
    await executeTool('login', cfg, {});
    expect(cfg.apiKey).toBe('');
  });
});

describe('logout tool', () => {
  it('delegates to logout() with the configured base URL', async () => {
    vi.mocked(logout).mockResolvedValueOnce('Signed out.');
    const result = await executeTool('logout', config({ baseUrl: 'https://staging.briefgate.dev' }), {});
    expect(vi.mocked(logout)).toHaveBeenCalledWith('https://staging.briefgate.dev');
    expect(result.text).toBe('Signed out.');
  });
});
