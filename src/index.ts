#!/usr/bin/env node
// BriefGate MCP server entrypoint.
// Supports two transports selected by CLI flags or environment variables:
//   stdio (default)      — for Claude Code, Cursor, and other local MCP clients
//   --http [--port N]    — Streamable HTTP for remote / multi-session usage
//     also activated by: BRIEFGATE_MCP_HTTP=1

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type BriefGateConfig } from './client.js';
import { TOOLS, executeTool } from './tools.js';
import { configForRequest, isAllowedHost, isAllowedOrigin } from './http-auth.js';
import { PayloadTooLargeError, readBody } from './http-body.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const apiKey = process.env['BRIEFGATE_API_KEY'];
const baseUrl =
  process.env['BRIEFGATE_BASE_URL'] ?? 'https://api.briefgate.dev';

// Warn early if BRIEFGATE_BASE_URL looks unsafe — it controls where API calls
// (including the Authorization header) are sent, so it must be an https URL in
// production. http:// is allowed without a warning for hosts that never leave
// a private network: localhost/127.0.0.1 (local development), a bare hostname
// with no dot (a Docker/Compose service name like "api" — only resolvable
// inside that network, e.g. BRIEFGATE_BASE_URL=http://api:8585), and the
// conventional private-network suffixes *.internal / *.local.
if (process.env['BRIEFGATE_BASE_URL']) {
  const isHttps = baseUrl.startsWith('https://');
  let isSafeHttp = false;
  if (!isHttps) {
    try {
      const hostname = new URL(baseUrl).hostname;
      isSafeHttp =
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        !hostname.includes('.') ||
        hostname.endsWith('.internal') ||
        hostname.endsWith('.local');
    } catch {
      // Malformed URL — leave isSafeHttp false so the warning fires; the
      // request itself will fail with a clearer error once it's attempted.
    }
  }
  if (!isHttps && !isSafeHttp) {
    process.stderr.write(
      'Warning: BRIEFGATE_BASE_URL does not use https:// — API keys will be sent over an insecure connection.\n',
    );
  }
}

if (!apiKey) {
  // Start anyway so clients and registries (e.g. Glama, mcp.so) can
  // introspect the tool list before a key is configured. Tool calls return
  // a clear error until BRIEFGATE_API_KEY is set (see the CallTool handler).
  process.stderr.write(
    [
      'Warning: BRIEFGATE_API_KEY is not set — tool calls will fail until it is.',
      'Get an API key at https://briefgate.dev and set it in your MCP client config.',
      'Example: BRIEFGATE_API_KEY=bg_live_... npx @briefgate/mcp',
      '',
    ].join('\n'),
  );
}

const config: BriefGateConfig = {
  apiKey: apiKey ?? '',
  baseUrl,
};

// Set to the hostname this server is published under (e.g. mcp.briefgate.dev)
// to run it as a public, multi-customer endpoint. Unset — the default and the
// only thing `npx @briefgate/mcp --http` does on a laptop — keeps the server on
// loopback with the operator's own key, exactly as before.
//
// Turning it on changes two things on purpose:
//   * the listener binds 0.0.0.0 and the Host guard accepts this name, because
//     a server behind a reverse proxy is reached by its public name;
//   * the BRIEFGATE_API_KEY fallback is switched OFF. Leaving it on would let
//     an anonymous caller spend the operator's key, which is the whole failure
//     this mode has to avoid.
const PUBLIC_HOST = process.env['BRIEFGATE_MCP_PUBLIC_HOST'];

// The version handed to clients in the MCP handshake. Read from package.json
// rather than repeated here: hand-maintained it had drifted to 0.1.0 while the
// package shipped 0.3.0, so every client was told the wrong version.
const PACKAGE_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

// ─── Server factory ───────────────────────────────────────────────────────────

// Returns a fresh Server instance bound to one caller's config.
//
// HTTP mode builds one per request, which is what makes a public deployment
// possible at all: the API key travels with the request rather than the
// process, so two customers hitting the same server never share a credential.
function buildServer(cfg: BriefGateConfig): Server {
  const server = new Server(
    { name: '@briefgate/mcp', version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    if (!cfg.apiKey) {
      return {
        content: [
          {
            type: 'text' as const,
            text: PUBLIC_HOST
              ? 'Error: no API key was sent. Connect with an Authorization: Bearer bg_live_... header; get a key at https://briefgate.dev.'
              : 'Error: BRIEFGATE_API_KEY is not set. Get a key at https://briefgate.dev and add it to your MCP client config.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await executeTool(name, cfg, args);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  });

  return server;
}

// ─── Transport selection ──────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const useHttp =
  argv.includes('--http') ||
  process.env['BRIEFGATE_MCP_HTTP'] === '1';

if (useHttp) {
  // ── Streamable HTTP transport ──────────────────────────────────────────────

  // Parse --port N or fall back to env / default.
  const portIndex = argv.indexOf('--port');
  const portArg = portIndex !== -1 ? parseInt(argv[portIndex + 1] ?? '', 10) : NaN;
  const port = !isNaN(portArg)
    ? portArg
    : parseInt(process.env['BRIEFGATE_MCP_PORT'] ?? '', 10) || 3000;

  // Loopback unless this server is deliberately published. On a laptop the
  // loopback bind is what stops a browser-based attacker reaching the server at
  // all; behind a reverse proxy it would stop the proxy too.
  const host = PUBLIC_HOST ? '0.0.0.0' : '127.0.0.1';

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding guard: reject requests whose Host header does not resolve
    // to a loopback address. A real browser attacker cannot spoof this header,
    // but a misconfigured proxy or custom client might send something unexpected.
    const host_ = req.headers['host'] ?? '';
    if (!isAllowedHost(host_, PUBLIC_HOST)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: PUBLIC_HOST
          ? 'Invalid Host header'
          : 'Invalid Host header — only localhost connections are accepted',
      }));
      return;
    }

    // CORS: allow claude.ai and localhost origins; reject everything else.
    const origin = req.headers['origin'];
    if (origin !== undefined) {
      if (isAllowedOrigin(origin, PUBLIC_HOST)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
        // authorization is on the list because that is how a remote caller
        // sends its key; without it a browser client cannot connect at all.
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, authorization');
      } else {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Origin not allowed' }));
        return;
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    // Stateless mode: one Server + one Transport per request.
    // This is correct because MCP tool calls are independent request/response
    // cycles — no shared streaming context is needed between calls.
    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null }),
        );
        // The body was abandoned mid-stream, so the socket may still be sitting
        // on unread bytes the client is trying to push — close it outright
        // rather than leaving it open for `end` to (never) fire.
        req.socket.destroy();
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer(configForRequest(req, { publicHost: PUBLIC_HOST, envApiKey: apiKey, baseUrl }));

    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
      process.stderr.write(`BriefGate MCP HTTP error: ${String(err)}\n`);
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(`BriefGate MCP server listening on http://${host}:${port}\n`);
  });

  httpServer.on('error', (err) => {
    process.stderr.write(`BriefGate MCP HTTP server error: ${String(err)}\n`);
    process.exit(1);
  });
} else {
  // ── stdio transport (default) ──────────────────────────────────────────────
  // One process, one user, key from the environment — a local client has no
  // other way to hand one over.
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

