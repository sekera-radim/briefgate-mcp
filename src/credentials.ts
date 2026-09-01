// Local credential store backing the `login`/`logout` tools.
//
// Keyed by base URL so a staging BRIEFGATE_BASE_URL and production never
// collide, and file/dir permissions are forced to 600/700 because this file
// holds a live API key. Never used when the server is published under
// BRIEFGATE_MCP_PUBLIC_HOST — that mode is a shared multi-customer process, and
// a file on that host is not a place to keep any one caller's key.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

export interface StoredCredential {
  api_key: string;
  key_id?: string;
  account_name?: string;
  saved_at: string;
}

type CredentialsFile = Record<string, StoredCredential>;

/** Overridable via BRIEFGATE_CREDENTIALS_FILE so tests never touch ~/.briefgate. */
export function credentialsPath(): string {
  return process.env['BRIEFGATE_CREDENTIALS_FILE'] ?? `${homedir()}/.briefgate/credentials.json`;
}

function readAll(): CredentialsFile {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CredentialsFile;
    }
    return {};
  } catch (err) {
    // Corrupt or unreadable file — treat as empty rather than crashing the
    // server; the next successful `login` overwrites it with a valid one.
    console.error(`[briefgate] could not read ${path}: ${(err as Error).message}`);
    return {};
  }
}

function writeAll(data: CredentialsFile): void {
  const path = credentialsPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  // The `mode` passed to mkdir/writeFile above is masked by the process
  // umask, so force the permissions explicitly rather than merely requesting
  // them — this file is as sensitive as an SSH private key.
  try {
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
  } catch (err) {
    // Windows has no POSIX mode bits; anywhere else this is worth knowing.
    if (process.platform !== 'win32') {
      console.error(`[briefgate] could not restrict permissions on ${path}: ${(err as Error).message}`);
    }
  }
}

export function loadCredential(baseUrl: string): StoredCredential | undefined {
  return readAll()[baseUrl];
}

export function saveCredential(baseUrl: string, cred: StoredCredential): void {
  const all = readAll();
  all[baseUrl] = cred;
  writeAll(all);
}

/** Returns true if a credential existed and was removed. */
export function deleteCredential(baseUrl: string): boolean {
  const all = readAll();
  if (!(baseUrl in all)) return false;
  delete all[baseUrl];
  writeAll(all);
  return true;
}

// ─── Resolving the key to use for one process/request ────────────────────────

export type ApiKeySource = 'flag' | 'env' | 'header' | 'file' | 'none';

export interface ResolvedApiKey {
  apiKey: string;
  source: ApiKeySource;
}

/**
 * Priority: an explicit key (CLI flag, or a request's Authorization header in
 * HTTP mode) beats the environment, which beats the locally stored one.
 * `allowFileFallback` must be false whenever the server is published — see
 * the module comment.
 */
export function resolveApiKey(opts: {
  explicitApiKey?: string | undefined;
  explicitSource?: 'flag' | 'header';
  envApiKey?: string | undefined;
  baseUrl: string;
  allowFileFallback: boolean;
}): ResolvedApiKey {
  if (opts.explicitApiKey) {
    return { apiKey: opts.explicitApiKey, source: opts.explicitSource ?? 'flag' };
  }
  if (opts.envApiKey) {
    return { apiKey: opts.envApiKey, source: 'env' };
  }
  if (opts.allowFileFallback) {
    const cred = loadCredential(opts.baseUrl);
    if (cred) return { apiKey: cred.api_key, source: 'file' };
  }
  return { apiKey: '', source: 'none' };
}
