// Builds the Claude Desktop Extension (.mcpb) bundle for local one-click
// install. Packs a *production-only* copy of the server — devDependencies
// (typescript, eslint, vitest, tsx...) would otherwise bloat the bundle for
// no reason, since Claude Desktop only ever runs `dist/index.js`.
//
// Runs entirely in a throwaway staging directory so it never touches this
// repo's own node_modules/dist. Output: briefgate.mcpb at the repo root
// (gitignored — see MCPB README section for why it isn't committed).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const staging = mkdtempSync(join(tmpdir(), 'briefgate-mcpb-'));

try {
  console.log('1/4 Building dist/ ...');
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });

  console.log('2/4 Staging production-only package ...');
  cpSync(join(repoRoot, 'dist'), join(staging, 'dist'), { recursive: true });
  cpSync(join(repoRoot, 'manifest.json'), join(staging, 'manifest.json'));
  cpSync(join(repoRoot, 'README.md'), join(staging, 'README.md'));
  cpSync(join(repoRoot, 'LICENSE'), join(staging, 'LICENSE'));

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.scripts; // avoid accidental lifecycle scripts running in staging
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2));

  console.log('3/4 Installing production dependencies in staging ...');
  execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: staging,
    stdio: 'inherit',
  });

  console.log('4/4 Packing .mcpb bundle ...');
  const outFile = join(repoRoot, 'briefgate.mcpb');
  execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'pack', staging, outFile], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  console.log(`Done: ${outFile}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
