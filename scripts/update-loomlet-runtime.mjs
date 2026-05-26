import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultLoomletRepo = path.resolve(repoRoot, '..', 'loomlet');
const loomletRepo = path.resolve(process.argv[2] || process.env.LOOMLET_REPO || defaultLoomletRepo);

const packageJson = JSON.parse(
  await fs.readFile(path.join(loomletRepo, 'package.json'), 'utf8')
);

const version = packageJson.version;
if (!version) {
  throw new Error(`Missing Loomlet package version in ${loomletRepo}`);
}

const source = path.join(loomletRepo, 'dist', 'loomlet-scenesync-runtime.browser.js');
const destDir = path.join(repoRoot, 'html', 'assets', 'vendor', 'loomlet', version);
const dest = path.join(destDir, 'loomlet-scenesync-runtime.browser.js');

const bundle = await fs.readFile(source, 'utf8');
if (/from\s+['"]|import\s+/.test(bundle)) {
  throw new Error('Vendored Loomlet Scene Sync runtime must be self-contained ESM with no imports');
}
if (/parseDSL|compileToGraph|compileLoomSource|loom-dsl/.test(bundle)) {
  throw new Error('Vendored Loomlet Scene Sync runtime must not include the DSL compiler');
}
if (/cdn\.jsdelivr|unpkg|afjk\.jp|presence-server|presence server/.test(bundle)) {
  throw new Error('Vendored Loomlet Scene Sync runtime must not include runtime network dependencies');
}

await fs.mkdir(destDir, { recursive: true });
await fs.writeFile(dest, bundle, 'utf8');

console.log(`Vendored Loomlet Scene Sync runtime ${version} to ${path.relative(repoRoot, dest)}`);
