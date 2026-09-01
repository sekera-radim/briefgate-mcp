/**
 * End-to-end HTTP behavior of `--http` mode. Everything unit-testable was
 * already pulled out into http-auth.ts (see http-auth.test.ts); what's left
 * here is the wiring in index.ts itself — real requests over a real socket —
 * for the three things a published, OAuth-fronted deployment must get right:
 * the well-known route, the Bearer-required gate, and the 401 rewrite on an
 * expired/revoked key. Also confirms local (non-published) mode is untouched.
 *
 * Spawns the actual CLI via tsx rather than importing src/index.ts directly,
 * because that module starts a real listener (or connects stdio) as a side
 * effect of being imported — there is no way to load it inertly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const ENTRY = join(__dirname, '..', 'src', 'index.ts');
const STARTUP_TIMEOUT_MS = 15_000;

function randomPort(): number {
  return 31000 + Math.floor(Math.random() * 9000);
}

/** A stand-in BriefGate API that always answers 401, to exercise the rewrite path. */
function startMockApi(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_key', message: 'nope' }));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function spawnMcpServer(env: Record<string, string>, port: number): Promise<ChildProcessByStdio<null, Readable, Readable>> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY, '--http', '--port', String(port)], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('MCP server did not report "listening" in time'));
    }, STARTUP_TIMEOUT_MS);

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes('listening on')) {
        clearTimeout(timeout);
        resolve(child);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`MCP server exited early (code ${code}). stderr:\n${stderr}`));
    });
  });
}

async function rpc(baseUrl: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const initializeRequest = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  },
};

const toolsListRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('published mode (BRIEFGATE_MCP_PUBLIC_HOST set)', () => {
  const port = randomPort();
  const publicHost = `localhost:${port}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  let child: ChildProcessByStdio<null, Readable, Readable>;
  let mockApi: { server: Server; url: string };

  beforeAll(async () => {
    mockApi = await startMockApi();
    child = await spawnMcpServer(
      {
        BRIEFGATE_MCP_PUBLIC_HOST: publicHost,
        BRIEFGATE_BASE_URL: mockApi.url,
        BRIEFGATE_MCP_AUTH_SERVER: 'https://api.briefgate.dev',
      },
      port,
    );
  }, STARTUP_TIMEOUT_MS + 2000);

  afterAll(() => {
    child?.kill();
    mockApi?.server.close();
  });

  const expectedMetadata = {
    resource: `https://${publicHost}/mcp`,
    authorization_servers: ['https://api.briefgate.dev'],
    bearer_methods_supported: ['header'],
    scopes_supported: ['admin', 'intakes:read', 'intakes:write', 'secrets:read'],
    resource_name: 'BriefGate MCP',
  };

  it('serves OAuth protected-resource metadata with open CORS', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.json()).toEqual(expectedMetadata);
  });

  it('serves identical metadata under the resource-scoped well-known path too', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`, {
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expectedMetadata);
  });

  it('answers the well-known route\'s OPTIONS preflight', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('rejects tools/list with no Bearer token, pointing at the resource metadata', async () => {
    const res = await rpc(baseUrl, toolsListRequest);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer resource_metadata="https://${publicHost}/.well-known/oauth-protected-resource"`,
    );
  });

  it('rejects initialize the same way — not just tool calls', async () => {
    const res = await rpc(baseUrl, initializeRequest);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
  });

  it('serves tools/list once a Bearer token is present, without validating it', async () => {
    const res = await rpc(baseUrl, toolsListRequest, {
      Authorization: 'Bearer bg_live_whatever',
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"login"');
    expect(text).toContain('"logout"');
  });

  it('refuses login/logout with a clear message instead of running the device flow', async () => {
    const res = await rpc(
      baseUrl,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'login', arguments: {} } },
      { Authorization: 'Bearer bg_live_whatever' },
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).toContain('not available');
    expect(text).toContain('"isError":true');
  });

  it('rewrites an auth-failed tool call into a real HTTP 401 with error="invalid_token"', async () => {
    const res = await rpc(
      baseUrl,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_intakes', arguments: {} } },
      { Authorization: 'Bearer bg_live_expired' },
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="https://${publicHost}/.well-known/oauth-protected-resource"`,
    );
    const text = await res.text();
    expect(text).toContain('Authentication failed');
  });

  it('allows an arbitrary origin on /mcp itself, not just the well-known route', async () => {
    const res = await rpc(baseUrl, toolsListRequest, {
      Authorization: 'Bearer bg_live_whatever',
      Origin: 'https://some-oauth-client.example',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://some-oauth-client.example');
  });

  it('answers an /mcp OPTIONS preflight from any origin with the MCP transport headers allowed', async () => {
    const res = await fetch(baseUrl, {
      method: 'OPTIONS',
      headers: { Origin: 'https://some-oauth-client.example' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://some-oauth-client.example');
    const allowedHeaders = res.headers.get('Access-Control-Allow-Headers') ?? '';
    expect(allowedHeaders).toContain('Mcp-Protocol-Version');
    expect(allowedHeaders).toContain('Mcp-Session-Id');
    expect(allowedHeaders).toContain('Authorization');
  });
});

describe('local mode (no BRIEFGATE_MCP_PUBLIC_HOST) is unchanged', () => {
  const port = randomPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let child: ChildProcessByStdio<null, Readable, Readable>;

  beforeAll(async () => {
    child = await spawnMcpServer({ BRIEFGATE_API_KEY: 'bg_live_local_operator' }, port);
  }, STARTUP_TIMEOUT_MS + 2000);

  afterAll(() => {
    child?.kill();
  });

  it('still answers tools/list with no Authorization header at all', async () => {
    const res = await rpc(baseUrl, toolsListRequest);
    expect(res.status).toBe(200);
  });

  it('still answers initialize with no Authorization header', async () => {
    const res = await rpc(baseUrl, initializeRequest);
    expect(res.status).toBe(200);
  });
});
