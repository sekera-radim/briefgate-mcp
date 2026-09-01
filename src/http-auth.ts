// Who a request speaks for, and whether it is allowed to reach us at all.
//
// Split out of index.ts because index.ts starts a listener on import, and the
// two decisions below are the ones a public deployment must not get wrong.
import type { IncomingMessage } from 'node:http';
import type { BriefGateConfig } from './client.js';
import { resolveApiKey } from './credentials.js';

export interface HttpAuthOptions {
  /** Hostname this server is published under, or undefined when it is loopback-only. */
  publicHost?: string | undefined;
  /** The operator's own key, from --api-key, used only when NOT published. */
  cliApiKey?: string | undefined;
  /** The operator's own key, from BRIEFGATE_API_KEY, used only when NOT published. */
  envApiKey?: string | undefined;
  baseUrl: string;
}

/**
 * The API key for one request.
 *
 * Published mode reads it from the Authorization header and nowhere else. The
 * --api-key / environment / locally-stored-credential fallbacks exist so a
 * laptop can run `--http` against the operator's own key (or one saved by
 * `login`); on a public endpoint any of those would hand that key to whoever
 * asked first, so all three are switched off there rather than merely
 * discouraged.
 *
 * An absent key is not an error here. `initialize` and `tools/list` have to work
 * without one, or no registry can read the tool list before anybody signs up —
 * a tool call with no key fails later with a sentence saying so. Published
 * mode is stricter about this at the HTTP layer (see index.ts): a request with
 * no Bearer token never reaches this function at all.
 */
export function configForRequest(req: IncomingMessage, opts: HttpAuthOptions): BriefGateConfig {
  const header = req.headers['authorization'];
  const bearer =
    typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;

  if (opts.publicHost) {
    return { apiKey: bearer ?? '', baseUrl: opts.baseUrl, apiKeySource: bearer ? 'header' : 'none' };
  }
  if (bearer) return { apiKey: bearer, baseUrl: opts.baseUrl, apiKeySource: 'header' };

  const { apiKey, source } = resolveApiKey({
    explicitApiKey: opts.cliApiKey,
    explicitSource: 'flag',
    envApiKey: opts.envApiKey,
    baseUrl: opts.baseUrl,
    allowFileFallback: true,
  });
  return { apiKey, baseUrl: opts.baseUrl, apiKeySource: source };
}

const LOOPBACK_HOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;

/**
 * DNS-rebinding guard. On a laptop this is what stops a page in the user's own
 * browser from talking to the server; published, it also refuses traffic that
 * arrived under someone else's name — a proxy misroute, or a second hostname
 * pointed at this box by whoever noticed the IP.
 */
export function isAllowedHost(host: string, publicHost?: string | undefined): boolean {
  const withoutPort = host.replace(/:\d+$/, '').toLowerCase();
  if (publicHost && withoutPort === publicHost.toLowerCase()) return true;
  return LOOPBACK_HOST_RE.test(host);
}

/** Loopback origins and claude.ai, which proxies MCP for its own clients. */
const SAFE_ORIGIN_RE =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$|^https:\/\/claude\.ai$/;

/**
 * Published mode allows any origin: the resource is protected by the Bearer
 * token, which — unlike a cookie — a browser never attaches on its own, so
 * restricting origins buys no extra security and would only stop legitimate
 * OAuth-registered clients (claude.ai and others) from connecting. Loopback
 * mode keeps the strict allowlist: there, a plain `--http` run may still be
 * relying on an operator key with no per-request Bearer at all, so the origin
 * check is doing real work.
 */
export function isAllowedOrigin(origin: string, publicHost?: string | undefined): boolean {
  if (publicHost) return true;
  return SAFE_ORIGIN_RE.test(origin);
}

// ─── OAuth 2.1 protected-resource metadata (published mode only) ─────────────
//
// Lets an MCP client (claude.ai's connector UI) discover, from the server URL
// alone, which authorization server to run OAuth against — RFC 9728 as
// profiled by the MCP authorization spec.

// RFC 9728 defines the bare path; the MCP authorization spec also has clients
// look under a path scoped to the resource itself (the resource being `/mcp`
// here) — both must serve identical content.
export const WELL_KNOWN_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';
export const WELL_KNOWN_PROTECTED_RESOURCE_MCP_PATH = `${WELL_KNOWN_PROTECTED_RESOURCE_PATH}/mcp`;

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
  scopes_supported: string[];
  resource_name: string;
}

export function protectedResourceMetadata(
  publicHost: string,
  authServer: string,
): ProtectedResourceMetadata {
  return {
    resource: `https://${publicHost}/mcp`,
    authorization_servers: [authServer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['admin', 'intakes:read', 'intakes:write', 'secrets:read'],
    resource_name: 'BriefGate MCP',
  };
}

/**
 * Value for the `WWW-Authenticate` header on a 401, pointing the client at
 * the resource metadata above so it knows where to start the OAuth dance.
 * Pass `error: 'invalid_token'` when the caller did send a Bearer token and
 * it was specifically rejected (expired/revoked) — as opposed to no token
 * having been sent at all — so the client knows to refresh rather than just
 * retry the same one.
 */
export function wwwAuthenticateHeader(publicHost: string, error?: 'invalid_token'): string {
  const resourceMetadata = `resource_metadata="https://${publicHost}${WELL_KNOWN_PROTECTED_RESOURCE_PATH}"`;
  return error ? `Bearer error="${error}", ${resourceMetadata}` : `Bearer ${resourceMetadata}`;
}
