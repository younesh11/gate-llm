import { readFileSync, writeFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('Use a stable x.y.z version for the shared npm/PyPI release.');
const generated = `# Generated from package.json by scripts/sync-version.mjs\n__version__ = "${pkg.version}"\n`;
const path = 'packaging/python/src/relay_gateway/_version.py';
const docker = readFileSync('Dockerfile', 'utf8');
const compose = readFileSync('compose.yaml', 'utf8');
const nextDocker = docker.replace(/^ARG VERSION=.*$/m, `ARG VERSION=${pkg.version}`);
const nextCompose = compose.replace(/GATE_IMAGE:-gate-llm:[^}]+/, `GATE_IMAGE:-gate-llm:${pkg.version}`).replace(/GATE_VERSION:-[^}]+/, `GATE_VERSION:-${pkg.version}`);
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== generated) throw new Error('Python version differs from package.json; run node scripts/sync-version.mjs.');
  if (!readFileSync('CHANGELOG.md', 'utf8').includes(`## [${pkg.version}]`)) throw new Error('Add release notes to CHANGELOG.md.');
  if (docker !== nextDocker || compose !== nextCompose) throw new Error('Docker versions differ from package.json; run node scripts/sync-version.mjs.');
  console.log(`Release versions match: ${pkg.version}`);
} else {
  writeFileSync(path, generated);
  writeFileSync('Dockerfile', nextDocker);
  writeFileSync('compose.yaml', nextCompose);
}
