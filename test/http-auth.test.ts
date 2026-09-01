/**
 * The two decisions a public MCP endpoint must not get wrong: whose key a
 * request speaks with, and whether it is allowed to reach us under that name.
 */
import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { configForRequest, isAllowedHost, isAllowedOrigin } from '../src/http-auth.js';

const req = (headers: Record<string, string>) => ({ headers }) as unknown as IncomingMessage;
const BASE = 'https://api.briefgate.dev';
const PUBLISHED = { publicHost: 'mcp.briefgate.dev', envApiKey: 'bg_live_OPERATOR', baseUrl: BASE };
const LOCAL = { publicHost: undefined, envApiKey: 'bg_live_OPERATOR', baseUrl: BASE };

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
    expect(configForRequest(req({}), LOCAL).apiKey).toBe('bg_live_OPERATOR');
  });

  it('still prefers an explicit header over it', () => {
    expect(configForRequest(req({ authorization: 'Bearer bg_live_ALICE' }), LOCAL).apiKey)
      .toBe('bg_live_ALICE');
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

describe('isAllowedOrigin', () => {
  it('allows loopback, claude.ai and the published origin', () => {
    expect(isAllowedOrigin('http://localhost:5173', undefined)).toBe(true);
    expect(isAllowedOrigin('https://claude.ai', undefined)).toBe(true);
    expect(isAllowedOrigin('https://mcp.briefgate.dev', 'mcp.briefgate.dev')).toBe(true);
  });

  it('refuses everything else', () => {
    for (const o of ['https://evil.example', 'https://claude.ai.evil.example', 'http://mcp.briefgate.dev']) {
      expect(isAllowedOrigin(o, 'mcp.briefgate.dev'), o).toBe(false);
    }
  });
});
