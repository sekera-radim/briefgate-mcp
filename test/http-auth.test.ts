/**
 * The two decisions a public MCP endpoint must not get wrong: whose key a
 * request speaks with, and whether it is allowed to reach us under that name.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configForRequest,
  isAllowedHost,
  isAllowedOrigin,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  WELL_KNOWN_PROTECTED_RESOURCE_PATH,
} from '../src/http-auth.js';
import { saveCredential } from '../src/credentials.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const BASE = 'https://api.briefgate.dev';
const PUBLISHED = { publicHost: 'mcp.briefgate.dev', envApiKey: 'bg_live_OPERATOR', baseUrl: BASE };
const LOCAL = { publicHost: undefined, envApiKey: 'bg_live_OPERATOR', baseUrl: BASE };

// configForRequest falls back to a locally stored credential (see
// credentials.ts). Point it at a throwaway file for every test in this file —
// never at the real ~/.briefgate/credentials.json, which may hold a real key
// on whatever machine runs these tests.
let dir: string;
const ORIGINAL_ENV = process.env['BRIEFGATE_CREDENTIALS_FILE'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'briefgate-mcp-http-auth-test-'));
  process.env['BRIEFGATE_CREDENTIALS_FILE'] = join(dir, 'credentials.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env['BRIEFGATE_CREDENTIALS_FILE'];
  else process.env['BRIEFGATE_CREDENTIALS_FILE'] = ORIGINAL_ENV;
});

describe('configForRequest — published', () => {
  it('speaks with the key the caller sent', () => {
    expect(configForRequest(req({ authorization: 'Bearer bg_live_ALICE' }), PUBLISHED).apiKey)
      .toBe('bg_live_ALICE');
  });

  it('never falls back to the operator key', () => {
    // The whole point of the mode. If this ever passes the operator's key to an
    // anonymous caller, every customer's data is one curl away.
    expect(configForRequest(req({}), PUBLISHED).apiKey).toBe('');
  });

  it('keeps two callers apart', () => {
    const a = configForRequest(req({ authorization: 'Bearer bg_live_A' }), PUBLISHED);
    const b = configForRequest(req({ authorization: 'Bearer bg_live_B' }), PUBLISHED);
    expect(a.apiKey).toBe('bg_live_A');
    expect(b.apiKey).toBe('bg_live_B');
  });

  it('accepts the scheme in any case, and ignores a malformed header', () => {
    expect(configForRequest(req({ authorization: 'bearer bg_live_X' }), PUBLISHED).apiKey).toBe('bg_live_X');
    expect(configForRequest(req({ authorization: 'Basic abc' }), PUBLISHED).apiKey).toBe('');
    expect(configForRequest(req({ authorization: 'Bearer' }), PUBLISHED).apiKey).toBe('');
  });
});

describe('configForRequest — loopback', () => {
  it('uses the environment key, which is how a laptop supplies one', () => {
    const cfg = configForRequest(req({}), LOCAL);
    expect(cfg.apiKey).toBe('bg_live_OPERATOR');
    expect(cfg.apiKeySource).toBe('env');
  });

  it('still prefers an explicit header over it', () => {
    const cfg = configForRequest(req({ authorization: 'Bearer bg_live_ALICE' }), LOCAL);
    expect(cfg.apiKey).toBe('bg_live_ALICE');
    expect(cfg.apiKeySource).toBe('header');
  });

  it('prefers --api-key (cliApiKey) over the environment', () => {
    const cfg = configForRequest(req({}), { ...LOCAL, cliApiKey: 'bg_live_FLAG' });
    expect(cfg.apiKey).toBe('bg_live_FLAG');
    expect(cfg.apiKeySource).toBe('flag');
  });

  it('falls back to a key saved locally by `login` when nothing else is set', () => {
    saveCredential(BASE, { api_key: 'bg_live_FROM_FILE', saved_at: 't' });
    const cfg = configForRequest(req({}), { publicHost: undefined, baseUrl: BASE });
    expect(cfg.apiKey).toBe('bg_live_FROM_FILE');
    expect(cfg.apiKeySource).toBe('file');
  });

  it('reports no key configured when nothing is set at all', () => {
    const cfg = configForRequest(req({}), { publicHost: undefined, baseUrl: BASE });
    expect(cfg.apiKey).toBe('');
    expect(cfg.apiKeySource).toBe('none');
  });
});

describe('configForRequest — published never touches the local credential file', () => {
  it('ignores a locally stored key even with no header', () => {
    saveCredential(BASE, { api_key: 'bg_live_FROM_FILE', saved_at: 't' });
    const cfg = configForRequest(req({}), PUBLISHED);
    expect(cfg.apiKey).toBe('');
    expect(cfg.apiKeySource).toBe('none');
  });
});

describe('isAllowedHost', () => {
  it('allows loopback whether or not the server is published', () => {
    for (const h of ['localhost:3000', '127.0.0.1:3000', '[::1]', 'localhost']) {
      expect(isAllowedHost(h, undefined), h).toBe(true);
      expect(isAllowedHost(h, 'mcp.briefgate.dev'), h).toBe(true);
    }
  });

  it('allows the published name, with or without a port', () => {
    expect(isAllowedHost('mcp.briefgate.dev', 'mcp.briefgate.dev')).toBe(true);
    expect(isAllowedHost('mcp.briefgate.dev:443', 'mcp.briefgate.dev')).toBe(true);
    expect(isAllowedHost('MCP.BriefGate.dev', 'mcp.briefgate.dev')).toBe(true);
  });

  it('refuses any other name, published or not', () => {
    // Someone who notices the IP and points their own hostname at it, or a
    // proxy that misroutes — neither should reach the server.
    for (const h of ['evil.example', 'briefgate.dev', 'mcp.briefgate.dev.evil.example']) {
      expect(isAllowedHost(h, 'mcp.briefgate.dev'), h).toBe(false);
      expect(isAllowedHost(h, undefined), h).toBe(false);
    }
  });
});

describe('isAllowedOrigin — loopback (no publicHost)', () => {
  it('allows loopback and claude.ai', () => {
    expect(isAllowedOrigin('http://localhost:5173', undefined)).toBe(true);
    expect(isAllowedOrigin('https://claude.ai', undefined)).toBe(true);
  });

  it('refuses everything else — the origin check is doing real work here', () => {
    for (const o of ['https://evil.example', 'https://claude.ai.evil.example', 'https://mcp.briefgate.dev']) {
      expect(isAllowedOrigin(o, undefined), o).toBe(false);
    }
  });
});

describe('isAllowedOrigin — published', () => {
  it('allows any origin — the Bearer token is the real boundary, not same-origin', () => {
    for (const o of ['https://mcp.briefgate.dev', 'https://claude.ai', 'https://evil.example', 'http://anything']) {
      expect(isAllowedOrigin(o, 'mcp.briefgate.dev'), o).toBe(true);
    }
  });
});

describe('protectedResourceMetadata', () => {
  it('points at the public host for the resource and the given authorization server', () => {
    const meta = protectedResourceMetadata('mcp.briefgate.dev', 'https://api.briefgate.dev');
    expect(meta.resource).toBe('https://mcp.briefgate.dev/mcp');
    expect(meta.authorization_servers).toEqual(['https://api.briefgate.dev']);
    expect(meta.bearer_methods_supported).toEqual(['header']);
    expect(meta.scopes_supported).toEqual(['admin', 'intakes:read', 'intakes:write', 'secrets:read']);
  });

  it('passes the authorization server through as given — index.ts decides what that value is', () => {
    // BRIEFGATE_MCP_AUTH_SERVER vs. BRIEFGATE_BASE_URL is index.ts's call
    // (production points this at https://api.briefgate.dev even though the
    // container's own BRIEFGATE_BASE_URL is an internal address); this
    // function just needs to not silently substitute something else.
    const meta = protectedResourceMetadata('mcp.briefgate.dev', 'http://api:8585');
    expect(meta.authorization_servers).toEqual(['http://api:8585']);
  });

});

describe('wwwAuthenticateHeader', () => {
  it('points at the well-known resource-metadata path on the public host', () => {
    expect(wwwAuthenticateHeader('mcp.briefgate.dev')).toBe(
      `Bearer resource_metadata="https://mcp.briefgate.dev${WELL_KNOWN_PROTECTED_RESOURCE_PATH}"`,
    );
  });

  it('adds error="invalid_token" when the caller sent a token and it was specifically rejected', () => {
    expect(wwwAuthenticateHeader('mcp.briefgate.dev', 'invalid_token')).toBe(
      `Bearer error="invalid_token", resource_metadata="https://mcp.briefgate.dev${WELL_KNOWN_PROTECTED_RESOURCE_PATH}"`,
    );
  });
});
