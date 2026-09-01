// Who a request speaks for, and whether it is allowed to reach us at all.
//
// Split out of index.ts because index.ts starts a listener on import, and the
// two decisions below are the ones a public deployment must not get wrong.
import type { IncomingMessage } from 'node:http';
import type { BriefGateConfig } from './client.js';

export interface HttpAuthOptions {
  /** Hostname this server is published under, or undefined when it is loopback-only. */
  publicHost?: string | undefined;
  /** BRIEFGATE_API_KEY, used only when the server is NOT published. */
  envApiKey?: string | undefined;
  baseUrl: string;
}

/**
 * The API key for one request.
 *
 * Published mode reads it from the Authorization header and nowhere else. The
 * environment fallback exists so a laptop can run `--http` against the
 * operator's own key; on a public endpoint it would hand that key to whoever
 * asked first, so it is switched off there rather than merely discouraged.
 *
 * An absent key is not an error here. `initialize` and `tools/list` have to work
 * without one, or no registry can read the tool list before anybody signs up —
 * a tool call with no key fails later with a sentence saying so.
 */
export function configForRequest(req: IncomingMessage, opts: HttpAuthOptions): BriefGateConfig {
  const header = req.headers['authorization'];
  const bearer =
    typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim())?.[1] : undefined;

  const apiKey = opts.publicHost ? (bearer ?? '') : (bearer ?? opts.envApiKey ?? '');
  return { apiKey, baseUrl: opts.baseUrl };
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

export function isAllowedOrigin(origin: string, publicHost?: string | undefined): boolean {
  if (publicHost && origin.toLowerCase() === `https://${publicHost.toLowerCase()}`) return true;
  return SAFE_ORIGIN_RE.test(origin);
}
