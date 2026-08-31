#!/usr/bin/env node
// BriefGate MCP server entrypoint.
// Supports two transports selected by CLI flags or environment variables:
//   stdio (default)      — for Claude Code, Cursor, and other local MCP clients
//   --http [--port N]    — Streamable HTTP for remote / multi-session usage
//     also activated by: BRIEFGATE_MCP_HTTP=1

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

// ─── Config ───────────────────────────────────────────────────────────────────

const apiKey = process.env['BRIEFGATE_API_KEY'];
const baseUrl =
  process.env['BRIEFGATE_BASE_URL'] ?? 'https://api.briefgate.dev';

// Warn early if BRIEFGATE_BASE_URL looks unsafe — it controls where API calls
// (including the Authorization header) are sent, so it must be an https URL in
// production. http:// localhost/127.0.0.1 is allowed for local development.
if (process.env['BRIEFGATE_BASE_URL']) {
  const isLocalhostHttp = /^http:\/\/(?:localhost|127\.0\.0\.1)(:\d+)?(?:\/|$)/.test(baseUrl);
  if (!baseUrl.startsWith('https://') && !isLocalhostHttp) {
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

// ─── Server factory ───────────────────────────────────────────────────────────

// Returns a fresh Server instance bound to the shared config.
// In HTTP mode we create one Server per request (stateless pattern).
function buildServer(): Server {
  const server = new Server(
    { name: '@briefgate/mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    if (!apiKey) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Error: BRIEFGATE_API_KEY is not set. Get a key at https://briefgate.dev and add it to your MCP client config.',
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await executeTool(name, config, args);
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

  // Bind to loopback only — DNS rebinding attacks require the server to accept
  // requests from any origin; binding to 127.0.0.1 prevents cross-origin access
  // from a browser-based attacker even when the Host header is spoofed.
  const host = '127.0.0.1';

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // DNS rebinding guard: reject requests whose Host header does not resolve
    // to a loopback address. A real browser attacker cannot spoof this header,
    // but a misconfigured proxy or custom client might send something unexpected.
    const host_ = req.headers['host'] ?? '';
    if (!isSafeHost(host_)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Host header — only localhost connections are accepted' }));
      return;
    }

    // CORS: allow claude.ai and localhost origins; reject everything else.
    const origin = req.headers['origin'];
    if (origin !== undefined) {
      if (isSafeOrigin(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
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
    const rawBody = await readBody(req);
    let parsedBody: unknown;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();

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
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const SAFE_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
function isSafeHost(host: string): boolean {
  return SAFE_HOST_RE.test(host);
}

// Allow requests from localhost origins and claude.ai (which proxies MCP).
const SAFE_ORIGIN_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$|^https:\/\/claude\.ai$/;
function isSafeOrigin(origin: string): boolean {
  return SAFE_ORIGIN_RE.test(origin);
}
