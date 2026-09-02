// Keeps server.json (the MCP Registry manifest) on the same version as
// package.json. Runs from the npm "version" lifecycle, so `npm version x.y.z`
// bumps both in one commit; a registry publish with a stale server.json
// fails on "version already exists" after npm has already published.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const manifest = JSON.parse(readFileSync('server.json', 'utf8'));

manifest.version = version;
for (const pkg of manifest.packages ?? []) pkg.version = version;

writeFileSync('server.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(`server.json -> ${version}`);
