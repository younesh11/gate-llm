import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const manifest = JSON.parse(readFileSync('artifacts/npm/manifest.json', 'utf8'));
const path = `artifacts/npm/${manifest.filename}`;
if (createHash('sha256').update(readFileSync(path)).digest('hex') !== manifest.sha256) throw new Error('Package checksum mismatch.');
const files = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n');
for (const file of files) {
  if (!/^package\/(build\/|dist\/|docs\/|node_modules\/|package.json$|README.md$|LICENSE$|CHANGELOG.md$)/.test(file)) throw new Error(`Unexpected packaged file: ${file}`);
  if (/(^|\/)(\.env(?:\.[^/]*)?|data|\.git|\.npmrc|encryption\.key|process\.lock)(\/|$)|\.sqlite(?:-|$|\.)/.test(file)) throw new Error(`Private file in package: ${file}`);
}
for (const file of ['package/build/cli.js', 'package/build/app.js', 'package/dist/index.html', 'package/LICENSE', 'package/node_modules/fastify/fastify.js']) if (!files.includes(file)) throw new Error(`Missing release file: ${file}`);
console.log(`Package checked: ${files.length} files; compiled server, UI, bundled runtime dependencies, no local state.`);
