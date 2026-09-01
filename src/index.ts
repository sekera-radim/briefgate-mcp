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
import { hostname } from 'node:os';
import { type BriefGateConfig, AUTH_FAILED_MESSAGE } from './client.js';
import { TOOLS, executeTool } from './tools.js';
import {
  configForRequest,
  isAllowedHost,
  isAllowedOrigin,
  protectedResourceMetadata,
  wwwAuthenticateHeader,
  WELL_KNOWN_PROTECTED_RESOURCE_PATH,
  WELL_KNOWN_PROTECTED_RESOURCE_MCP_PATH,
} from './http-auth.js';
import { PayloadTooLargeError, readBody } from './http-body.js';
import { resolveApiKey } from './credentials.js';
import { loginBlocking, logout as logoutLocal } from './login.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const apiKeyFlagIndex = argv.indexOf('--api-key');
const cliApiKey = apiKeyFlagIndex !== -1 ? argv[apiKeyFlagIndex + 1] : undefined;

const envApiKey = process.env['BRIEFGATE_API_KEY'];
const baseUrl =
  process.env['BRIEFGATE_BASE_URL'] ?? 'https://api.briefgate.dev';
// The OAuth authorization server advertised in the well-known resource
// metadata (see protectedResourceMetadata below). Deliberately separate from
// BRIEFGATE_BASE_URL: in production the MCP container reaches the API over an
// internal network (BRIEFGATE_BASE_URL=http://api:8585), which the outside
// world — a browser, claude.ai — could never open. Defaults to BASE_URL only
// because that's convenient for local dev, where they're usually the same
// address; a real deployment sets this explicitly (docker-compose.prod.yml
// sets it to https://api.briefgate.dev).
const authServer = process.env['BRIEFGATE_MCP_AUTH_SERVER'] ?? baseUrl;

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
      const urlHostname = new URL(baseUrl).hostname;
      isSafeHttp =
        urlHostname === 'localhost' ||
        urlHostname === '127.0.0.1' ||
        urlHostname === '::1' ||
        !urlHostname.includes('.') ||
        urlHostname.endsWith('.internal') ||
        urlHostname.endsWith('.local');
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

// ─── CLI subcommands: `login` / `logout` ───────────────────────────────────────
//
// `npx @briefgate/mcp login` / `logout` — the same device-authorization flow
// as the `login`/`logout` MCP tools (src/login.ts), for a human running the
// package directly from a terminal instead of asking an agent to call the
// tool. Checked and handled before anything else: this is a one-shot command
// that exits, not a server, so none of PUBLIC_HOST, the API-key warning below,
// or a transport is relevant to it.
const cliSubcommand = argv[0] === 'login' || argv[0] === 'logout' ? argv[0] : undefined;

if (cliSubcommand === 'login') {
  // Same "already configured" gate as the login tool: --api-key/env always
  // override a locally stored key, so running the flow would be pointless.
  const { apiKey: preconfiguredKey, source: preconfiguredSource } = resolveApiKey({
    explicitApiKey: cliApiKey,
    explicitSource: 'flag',
    envApiKey,
    baseUrl,
    allowFileFallback: true,
  });
  if (preconfiguredKey && (preconfiguredSource === 'flag' || preconfiguredSource === 'env')) {
    const via = preconfiguredSource === 'flag' ? '--api-key' : 'BRIEFGATE_API_KEY';
    process.stdout.write(`An API key is already configured via ${via} — login is not needed.\n`);
  } else {
    const clientName = `briefgate-mcp CLI on ${hostname()}`;
    try {
      const result = await loginBlocking({ baseUrl, clientName }, ({ userCode, verificationUriComplete }) => {
        process.stdout.write(`Open ${verificationUriComplete} and confirm code ${userCode}.\n`);
        process.stdout.write('Waiting for approval (up to 10 minutes)...\n');
      });
      process.stdout.write(`${result.text}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  }
} else if (cliSubcommand === 'logout') {
  process.stdout.write(`${await logoutLocal(baseUrl)}\n`);
}

// Everything below only matters for actually running the server — skipped
// entirely for a CLI subcommand, which has already finished above.
if (!cliSubcommand) {
  // Set to the hostname this server is published under (e.g. mcp.briefgate.dev)
  // to run it as a public, multi-customer endpoint. Unset — the default and the
  // only thing `npx @briefgate/mcp --http` does on a laptop — keeps the server on
  // loopback with the operator's own key, exactly as before.
  //
  // Turning it on changes several things on purpose:
  //   * the listener binds 0.0.0.0 and the Host guard accepts this name, because
  //     a server behind a reverse proxy is reached by its public name;
  //   * the BRIEFGATE_API_KEY and locally-stored-credential fallbacks are
  //     switched OFF. Leaving either on would let an anonymous caller spend the
  //     operator's key, or read whatever `login` last wrote to this shared
  //     machine — which is the whole failure this mode has to avoid;
  //   * the server behaves as an OAuth 2.1 resource server (see the well-known
  //     route and the Bearer-required check below) instead of accepting an
  //     absent key on `initialize`/`tools/list`.
  const PUBLIC_HOST = process.env['BRIEFGATE_MCP_PUBLIC_HOST'];

  // Priority: --api-key > BRIEFGATE_API_KEY > a key `login` saved locally. The
  // last of those is unavailable in published mode — see PUBLIC_HOST above.
  const { apiKey, source: apiKeySource } = resolveApiKey({
    explicitApiKey: cliApiKey,
    explicitSource: 'flag',
    envApiKey,
    baseUrl,
    allowFileFallback: !PUBLIC_HOST,
  });

  if (!apiKey && !PUBLIC_HOST) {
    // Start anyway so clients and registries (e.g. Glama, mcp.so) can
    // introspect the tool list before a key is configured. Tool calls return
    // a clear error until one is available (see the CallTool handler).
    process.stderr.write(
      [
        'Warning: no BriefGate API key configured — tool calls will fail until one is.',
        'Either call the `login` tool from your MCP client to sign in interactively,',
        'or get a key at https://briefgate.dev and set BRIEFGATE_API_KEY / --api-key.',
        '',
      ].join('\n'),
    );
  }

  const config: BriefGateConfig = {
    apiKey,
    baseUrl,
    apiKeySource,
  };

  // The version handed to clients in the MCP handshake. Read from package.json
  // rather than repeated here: hand-maintained it had drifted to 0.1.0 while the
  // package shipped 0.3.0, so every client was told the wrong version.
  const PACKAGE_VERSION: string = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ).version;

  // ─── Server factory ───────────────────────────────────────────────────────────

  interface BuildServerOptions {
    // Gates `login`/`logout`: meaningless (and unsafe — see credentials.ts) on
    // a shared published endpoint, where OAuth handles sign-in instead.
    isPublicHost: boolean;
    // Reports the text of a failed tool call so the HTTP layer can turn a
    // specific one (an expired/revoked key) into a real HTTP 401 for OAuth
    // clients. The MCP transport always answers CallTool with HTTP 200 — a
    // tool result carries its error inside the JSON-RPC body, not the status
    // line — so that rewrite has to happen one level up, in the raw response;
    // this callback is how buildServer hands it the information to do that.
    onToolError?: (message: string) => void;
  }

  // Returns a fresh Server instance bound to one caller's config.
  //
  // HTTP mode builds one per request, which is what makes a public deployment
  // possible at all: the API key travels with the request rather than the
  // process, so two customers hitting the same server never share a credential.
  function buildServer(cfg: BriefGateConfig, opts: BuildServerOptions): Server {
    const server = new Server(
      { name: '@briefgate/mcp', version: PACKAGE_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      const args = (rawArgs ?? {}) as Record<string, unknown>;

      // login/logout never need cfg.apiKey — signing in is the point of one,
      // and the other only touches a local file — so they run before the
      // missing-key check below, and are the one thing this handler treats
      // differently between published and non-published mode.
      if (name === 'login' || name === 'logout') {
        if (opts.isPublicHost) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'login/logout are not available on the hosted endpoint — connecting your client already triggers OAuth automatically. Manage keys at https://briefgate.dev.',
              },
            ],
            isError: true,
          };
        }
        const result = await executeTool(name, cfg, args, { clientName: server.getClientVersion()?.name });
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      }

      if (!cfg.apiKey) {
        return {
          content: [
            {
              type: 'text' as const,
              text: opts.isPublicHost
                ? 'Error: no API key was sent. Connect with an Authorization: Bearer bg_live_... header; get a key at https://briefgate.dev.'
                : 'Not signed in. Call the `login` tool — it opens a browser page where you approve this device.',
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await executeTool(name, cfg, args);
        if (result.isError) opts.onToolError?.(result.text);
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // opts.onToolError compares the raw message against AUTH_FAILED_MESSAGE
        // (published mode turns it into an HTTP 401), so it sees the original;
        // the person sees advice that fits how they signed in.
        opts.onToolError?.(raw);
        let message = raw;
        if (raw === AUTH_FAILED_MESSAGE) {
          message = opts.isPublicHost
            ? 'The access token was rejected: it has expired or was revoked. Your client needs to sign in to BriefGate again.'
            : 'This key was revoked or expired. Call `login` again.';
        }
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    });

    return server;
  }

  // ─── Transport selection ──────────────────────────────────────────────────────

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

      // OAuth resource metadata (RFC 9728): the one route on this server that
      // isn't MCP JSON-RPC. Handled before the origin allowlist below because
      // it must answer any origin — it's how a browser-based client discovers
      // where to run OAuth in the first place, before it has any reason to be
      // on our allowlist.
      const pathname = (() => {
        try {
          return new URL(req.url ?? '/', 'http://placeholder').pathname;
        } catch {
          return req.url ?? '/';
        }
      })();
      // RFC 9728 defines the bare path; the MCP authorization spec also has
      // clients look under one scoped to the resource itself — both must
      // serve identical content.
      if (
        PUBLIC_HOST &&
        (pathname === WELL_KNOWN_PROTECTED_RESOURCE_PATH || pathname === WELL_KNOWN_PROTECTED_RESOURCE_MCP_PATH)
      ) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(protectedResourceMetadata(PUBLIC_HOST, authServer)));
        return;
      }

      // CORS: allow claude.ai and localhost origins; on a published server,
      // any origin (see isAllowedOrigin's doc comment for why that's safe).
      const origin = req.headers['origin'];
      if (origin !== undefined) {
        if (isAllowedOrigin(origin, PUBLIC_HOST)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
          // authorization is on the list because that is how a remote caller
          // sends its key; without it a browser client cannot connect at all.
          // Mcp-Session-Id and Mcp-Protocol-Version are MCP transport headers
          // the SDK's client sends on every request.
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
          );
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

      // Published mode is a full OAuth 2.1 resource server: every MCP request —
      // including `initialize` and `tools/list`, which used to work without a
      // key so registries could introspect the tool list — now needs a Bearer
      // token, or the client has no signal to start the OAuth flow at all.
      // Non-published mode is untouched: it still allows an absent key through
      // to the CallTool handler, which reports the problem per-tool-call.
      if (PUBLIC_HOST) {
        const authHeader = req.headers['authorization'];
        const hasBearer = typeof authHeader === 'string' && /^Bearer\s+\S+$/i.test(authHeader.trim());
        if (!hasBearer) {
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': wwwAuthenticateHeader(PUBLIC_HOST),
          });
          res.end(
            JSON.stringify({
              error: 'unauthorized',
              message: 'Missing bearer token. Connect via OAuth — see the resource metadata for the authorization server.',
            }),
          );
          return;
        }
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

      // enableJsonResponse: this server never streams notifications to the
      // client mid-call, so there is nothing an SSE response buys here — every
      // request really is one request, one response. It also makes the 401
      // rewrite below possible at all: the SDK's default SSE mode opens the
      // stream (and so sends its 200 status line) before the tool call even
      // starts, long before we know whether it will fail with an expired key.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const cfg = configForRequest(req, { publicHost: PUBLIC_HOST, cliApiKey, envApiKey, baseUrl });

      // The MCP transport always answers a tool call with HTTP 200 — a failed
      // tool is a JSON-RPC-level result, not a transport-level one — so an
      // expired/revoked key can't turn into a real 401 from inside the CallTool
      // handler. We recover that signal here instead: buildServer tells us via
      // onToolError whether the just-finished call failed with exactly
      // AUTH_FAILED_MESSAGE, and if so this rewrites the response the transport
      // is about to send, right before it hits the socket. Node's http module
      // calls res.writeHead exactly once with the final status and headers
      // (confirmed against the @hono/node-server version this SDK uses), which
      // is what makes intercepting it here safe rather than fragile.
      let rewriteToAuthFailed = false;
      if (PUBLIC_HOST) {
        const originalWriteHead = res.writeHead.bind(res);
        res.writeHead = ((status: number, ...rest: unknown[]) => {
          if (rewriteToAuthFailed && status === 200) {
            return (originalWriteHead as (...a: unknown[]) => ServerResponse)(401, {
              'Content-Type': 'application/json',
              'WWW-Authenticate': wwwAuthenticateHeader(PUBLIC_HOST, 'invalid_token'),
            });
          }
          return (originalWriteHead as (...a: unknown[]) => ServerResponse)(status, ...rest);
        }) as typeof res.writeHead;
      }

      const server = buildServer(cfg, {
        isPublicHost: Boolean(PUBLIC_HOST),
        onToolError: (message) => {
          if (PUBLIC_HOST && message === AUTH_FAILED_MESSAGE) rewriteToAuthFailed = true;
        },
      });

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
    // One process, one user. `config` is a single mutable object shared by every
    // request this process handles: when `login` succeeds it writes to the
    // credentials file AND updates config.apiKey directly, so the very next
    // tool call in this same session picks up the new key without a restart.
    const server = buildServer(config, { isPublicHost: false });
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }
}
