import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  credentialsPath,
  loadCredential,
  saveCredential,
  deleteCredential,
  resolveApiKey,
} from '../src/credentials.js';

// Every test points BRIEFGATE_CREDENTIALS_FILE at a throwaway file inside a
// fresh temp directory — never the real ~/.briefgate/credentials.json. That
// file may hold a real, currently-valid key on the machine running these
// tests, and reading it here would both leak it into test state and make
// results depend on whoever's laptop CI happens to run on.
let dir: string;
let file: string;
const ORIGINAL_ENV = process.env['BRIEFGATE_CREDENTIALS_FILE'];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'briefgate-mcp-test-'));
  file = join(dir, 'nested', 'credentials.json');
  process.env['BRIEFGATE_CREDENTIALS_FILE'] = file;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_ENV === undefined) delete process.env['BRIEFGATE_CREDENTIALS_FILE'];
  else process.env['BRIEFGATE_CREDENTIALS_FILE'] = ORIGINAL_ENV;
});

describe('credentialsPath', () => {
  it('honors BRIEFGATE_CREDENTIALS_FILE', () => {
    expect(credentialsPath()).toBe(file);
  });
});

describe('loadCredential / saveCredential', () => {
  it('returns undefined when nothing has been saved', () => {
    expect(loadCredential('https://api.briefgate.dev')).toBeUndefined();
  });

  it('round-trips a saved credential', () => {
    saveCredential('https://api.briefgate.dev', {
      api_key: 'bg_live_abc',
      key_id: 'key_1',
      account_name: 'Radim',
      saved_at: '2026-09-01T00:00:00.000Z',
    });
    expect(loadCredential('https://api.briefgate.dev')).toEqual({
      api_key: 'bg_live_abc',
      key_id: 'key_1',
      account_name: 'Radim',
      saved_at: '2026-09-01T00:00:00.000Z',
    });
  });

  it('keeps two base URLs apart', () => {
    saveCredential('https://api.briefgate.dev', {
      api_key: 'bg_live_prod',
      saved_at: '2026-09-01T00:00:00.000Z',
    });
    saveCredential('https://staging.briefgate.dev', {
      api_key: 'bg_test_staging',
      saved_at: '2026-09-01T00:00:00.000Z',
    });
    expect(loadCredential('https://api.briefgate.dev')?.api_key).toBe('bg_live_prod');
    expect(loadCredential('https://staging.briefgate.dev')?.api_key).toBe('bg_test_staging');
  });

  it('creates the directory and file with 700/600 permissions', () => {
    saveCredential('https://api.briefgate.dev', {
      api_key: 'bg_live_abc',
      saved_at: '2026-09-01T00:00:00.000Z',
    });
    expect(existsSync(file)).toBe(true);
    // & 0o777 strips the file-type bits statSync also reports.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir + '/nested').mode & 0o777).toBe(0o700);
  });

  it('treats a corrupt file as empty rather than throwing', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(file, 'not json{{{', 'utf8');
    // Should not throw, and should have nothing to read.
    expect(loadCredential('https://api.briefgate.dev')).toBeUndefined();
  });

  it('overwriting one base URL does not clobber another', () => {
    saveCredential('https://api.briefgate.dev', { api_key: 'first', saved_at: 't1' });
    saveCredential('https://staging.briefgate.dev', { api_key: 'other', saved_at: 't1' });
    saveCredential('https://api.briefgate.dev', { api_key: 'second', saved_at: 't2' });
    expect(loadCredential('https://api.briefgate.dev')?.api_key).toBe('second');
    expect(loadCredential('https://staging.briefgate.dev')?.api_key).toBe('other');
  });
});

describe('deleteCredential', () => {
  it('returns false and does nothing when there was no credential', () => {
    expect(deleteCredential('https://api.briefgate.dev')).toBe(false);
  });

  it('removes a stored credential and returns true', () => {
    saveCredential('https://api.briefgate.dev', { api_key: 'bg_live_abc', saved_at: 't' });
    expect(deleteCredential('https://api.briefgate.dev')).toBe(true);
    expect(loadCredential('https://api.briefgate.dev')).toBeUndefined();
  });

  it('leaves other base URLs alone', () => {
    saveCredential('https://api.briefgate.dev', { api_key: 'a', saved_at: 't' });
    saveCredential('https://staging.briefgate.dev', { api_key: 'b', saved_at: 't' });
    deleteCredential('https://api.briefgate.dev');
    expect(loadCredential('https://staging.briefgate.dev')?.api_key).toBe('b');
  });
});

describe('resolveApiKey', () => {
  const baseUrl = 'https://api.briefgate.dev';

  it('prefers an explicit (flag) key over everything else', () => {
    saveCredential(baseUrl, { api_key: 'from_file', saved_at: 't' });
    const result = resolveApiKey({
      explicitApiKey: 'from_flag',
      envApiKey: 'from_env',
      baseUrl,
      allowFileFallback: true,
    });
    expect(result).toEqual({ apiKey: 'from_flag', source: 'flag' });
  });

  it('falls back to the environment key when there is no explicit one', () => {
    saveCredential(baseUrl, { api_key: 'from_file', saved_at: 't' });
    const result = resolveApiKey({ envApiKey: 'from_env', baseUrl, allowFileFallback: true });
    expect(result).toEqual({ apiKey: 'from_env', source: 'env' });
  });

  it('falls back to the stored file key when nothing else is set', () => {
    saveCredential(baseUrl, { api_key: 'from_file', saved_at: 't' });
    const result = resolveApiKey({ baseUrl, allowFileFallback: true });
    expect(result).toEqual({ apiKey: 'from_file', source: 'file' });
  });

  it('never reads the file when allowFileFallback is false', () => {
    saveCredential(baseUrl, { api_key: 'from_file', saved_at: 't' });
    const result = resolveApiKey({ baseUrl, allowFileFallback: false });
    expect(result).toEqual({ apiKey: '', source: 'none' });
  });

  it('returns "none" with an empty key when nothing is configured', () => {
    const result = resolveApiKey({ baseUrl, allowFileFallback: true });
    expect(result).toEqual({ apiKey: '', source: 'none' });
  });
});
