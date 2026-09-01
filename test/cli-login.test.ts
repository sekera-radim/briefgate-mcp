/**
 * The `login`/`logout` CLI subcommands (argv[0] dispatch in index.ts, before
 * any MCP transport starts) — the same functions the MCP tools use
 * (src/login.ts), driven from a terminal instead of an agent. Spawns the
 * real CLI via tsx against a small mock device-authorization server, since
 * the dispatch logic and process exit codes live in index.ts itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TSX = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const ENTRY = join(__dirname, '..', 'src', 'index.ts');
const TIMEOUT_MS = 15_000;

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CLI did not exit in time. stdout:\n${stdout}\nstderr:\n${stderr}`));
    }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code });
    });
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/**
 * A mock BriefGate device-authorization + key-revocation server.
 * `pollBehavior` decides what /auth/device/poll answers on each successive
 * call — lets each test script exactly the sequence it needs.
 */
function startMockAuthServer(
  pollBehavior: (callNumber: number) => { status: number; body?: unknown },
  revokeStatus = 204,
): Promise<{ server: Server; url: string }> {
  let pollCalls = 0;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method === 'POST' && req.url === '/v1/auth/device/start') {
          await readJsonBody(req);
          send(res, 200, {
            device_code: 'dc_test',
            user_code: 'ABCD-EFGH',
            verification_uri: 'https://app.briefgate.dev/app/device',
            verification_uri_complete: 'https://app.briefgate.dev/app/device?code=ABCD-EFGH',
            expires_in: 20,
            interval: 1,
          });
          return;
        }
        if (req.method === 'POST' && req.url === '/v1/auth/device/poll') {
          await readJsonBody(req);
          pollCalls += 1;
          const { status, body } = pollBehavior(pollCalls);
          send(res, status, body);
          return;
        }
        if (req.method === 'DELETE' && req.url === '/v1/keys/current') {
          send(res, revokeStatus);
          return;
        }
        send(res, 404, { error: 'not_found' });
      })();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

let dir: string;
let credentialsFile: string;
let mock: { server: Server; url: string } | undefined;

afterEach(() => {
  mock?.server.close();
  mock = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function freshCredentialsFile(): string {
  dir = mkdtempSync(join(tmpdir(), 'briefgate-mcp-cli-test-'));
  credentialsFile = join(dir, 'credentials.json');
  return credentialsFile;
}

describe('login subcommand', () => {
  it('prints the code and URL, then "Signed in" on approval, exit 0', async () => {
    mock = await startMockAuthServer((call) =>
      call < 2
        ? { status: 428, body: { reason: 'authorization_pending' } }
        : { status: 200, body: { api_key: 'bg_live_cli_test', key_id: 'key_1', account_name: 'Radim', scopes: ['intakes:read'] } },
    );
    const file = freshCredentialsFile();

    const result = await runCli(['login'], {
      BRIEFGATE_BASE_URL: mock.url,
      BRIEFGATE_CREDENTIALS_FILE: file,
    });

    expect(result.stdout).toContain('ABCD-EFGH');
    expect(result.stdout).toContain('app.briefgate.dev/app/device');
    expect(result.stdout).toContain('Signed in as Radim');
    expect(result.code).toBe(0);

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved[mock.url].api_key).toBe('bg_live_cli_test');
  });

  it('exits 1 and reports denial without saving a credential', async () => {
    mock = await startMockAuthServer(() => ({ status: 403, body: { reason: 'device_denied' } }));
    const file = freshCredentialsFile();

    const result = await runCli(['login'], {
      BRIEFGATE_BASE_URL: mock.url,
      BRIEFGATE_CREDENTIALS_FILE: file,
    });

    expect(result.stdout.toLowerCase()).toContain('denied');
    expect(result.code).toBe(1);
    expect(existsSync(file)).toBe(false);
  });

  it('says an API key is already configured and never contacts the server', async () => {
    const file = freshCredentialsFile();
    const result = await runCli(['login'], {
      BRIEFGATE_BASE_URL: 'http://127.0.0.1:1', // nothing listens here — a real call would hang/fail
      BRIEFGATE_CREDENTIALS_FILE: file,
      BRIEFGATE_API_KEY: 'bg_live_preconfigured',
    });
    expect(result.stdout).toContain('already configured');
    expect(result.stdout).toContain('BRIEFGATE_API_KEY');
    expect(result.code).toBe(0);
  });
});

describe('logout subcommand', () => {
  it('says there is nothing to do when no credential is stored', async () => {
    const file = freshCredentialsFile();
    const result = await runCli(['logout'], {
      BRIEFGATE_BASE_URL: 'https://api.briefgate.dev',
      BRIEFGATE_CREDENTIALS_FILE: file,
    });
    expect(result.stdout.toLowerCase()).toContain('nothing to do');
    expect(result.code).toBe(0);
  });

  it('revokes the key remotely and removes the local file', async () => {
    mock = await startMockAuthServer(() => ({ status: 200 }), 204);
    const file = freshCredentialsFile();
    writeFileSync(
      file,
      JSON.stringify({ [mock.url]: { api_key: 'bg_live_to_revoke', saved_at: 't' } }),
    );

    const result = await runCli(['logout'], {
      BRIEFGATE_BASE_URL: mock.url,
      BRIEFGATE_CREDENTIALS_FILE: file,
    });

    expect(result.stdout).toMatch(/signed out/i);
    expect(result.stdout).toMatch(/revoked/i);
    expect(result.code).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved[mock.url]).toBeUndefined();
  });

  it('still removes the local file when the remote revoke is unreachable, with a warning', async () => {
    const file = freshCredentialsFile();
    const baseUrl = 'http://127.0.0.1:1'; // nothing listens here
    writeFileSync(file, JSON.stringify({ [baseUrl]: { api_key: 'bg_live_orphan', saved_at: 't' } }));

    const result = await runCli(['logout'], {
      BRIEFGATE_BASE_URL: baseUrl,
      BRIEFGATE_CREDENTIALS_FILE: file,
    });

    expect(result.stdout).toMatch(/could not be revoked/i);
    expect(result.stdout).toMatch(/keys page/i);
    expect(result.code).toBe(0);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved[baseUrl]).toBeUndefined();
  });
});
