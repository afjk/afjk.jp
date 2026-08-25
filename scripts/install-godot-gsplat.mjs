#!/usr/bin/env node
// Installs the pinned godot-gsplat source and a host release binary into a Godot project.
// Upstream has no published release archive yet, so SceneSync builds the audited commit
// with a committed Cargo.lock instead of following a moving main branch.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const UPSTREAM_URL = 'https://github.com/shiena/godot-gsplat.git';
const UPSTREAM_COMMIT = 'dfc8df4893f0f6e26c847590ff1669fa8404da6d';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const pinnedLock = path.join(scriptDir, 'third_party', 'godot-gsplat-Cargo.lock');
const compatibilityPatch = path.join(
  scriptDir,
  'third_party',
  'godot-gsplat-push-constant-padding.patch',
);

function parseArgs(argv) {
  const result = {
    project: path.join(repoRoot, 'godot'),
    source: '',
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--project') result.project = path.resolve(argv[++index]);
    else if (arg === '--source') result.source = path.resolve(argv[++index]);
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

function output(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8' }).trim();
}

function succeeds(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hostLibrary(source) {
  if (process.platform === 'darwin') {
    return path.join(source, 'target', 'release', 'libgodot_gsplat.dylib');
  }
  if (process.platform === 'linux') {
    return path.join(source, 'target', 'release', 'libgodot_gsplat.so');
  }
  if (process.platform === 'win32') {
    return path.join(source, 'target', 'release', 'godot_gsplat.dll');
  }
  throw new Error(`Unsupported host platform: ${process.platform}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/install-godot-gsplat.mjs [--project <Godot project>] [--source <checkout>]');
    return;
  }

  const projectFile = path.join(options.project, 'project.godot');
  if (!fs.existsSync(projectFile)) {
    throw new Error(`Godot project not found: ${projectFile}`);
  }
  if (!fs.existsSync(pinnedLock)) {
    throw new Error(`Pinned Cargo.lock not found: ${pinnedLock}`);
  }
  if (!fs.existsSync(compatibilityPatch)) {
    throw new Error(`Compatibility patch not found: ${compatibilityPatch}`);
  }

  let temporaryRoot = '';
  let source = options.source;
  if (!source) {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scenesync-godot-gsplat-'));
    source = path.join(temporaryRoot, 'source');
    process.once('exit', () => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
    run('git', ['clone', '--filter=blob:none', '--no-checkout', UPSTREAM_URL, source], temporaryRoot);
    run('git', ['checkout', '--detach', UPSTREAM_COMMIT], source);
  }

  const actualCommit = output('git', ['rev-parse', 'HEAD'], source);
  if (actualCommit !== UPSTREAM_COMMIT) {
    throw new Error(`Refusing unexpected godot-gsplat source ${actualCommit}; expected ${UPSTREAM_COMMIT}`);
  }

  fs.copyFileSync(pinnedLock, path.join(source, 'Cargo.lock'));
  if (succeeds('git', ['apply', '--unidiff-zero', '--check', compatibilityPatch], source)) {
    run('git', ['apply', '--unidiff-zero', compatibilityPatch], source);
  } else if (!succeeds(
    'git',
    ['apply', '--unidiff-zero', '--reverse', '--check', compatibilityPatch],
    source,
  )) {
    throw new Error('godot-gsplat push-constant compatibility patch no longer applies cleanly');
  }
  run('cargo', ['build', '--release', '--locked'], source);

  const library = hostLibrary(source);
  if (!fs.existsSync(library)) throw new Error(`Built GDExtension library not found: ${library}`);

  const destinationAddon = path.join(options.project, 'addons', 'godot_gsplat');
  const destinationReleaseTarget = path.join(options.project, 'target', 'release');
  const destinationDebugTarget = path.join(options.project, 'target', 'debug');
  const descriptor = path.join(options.project, 'godot_gsplat.gdextension');

  fs.rmSync(destinationAddon, { recursive: true, force: true });
  fs.cpSync(path.join(source, 'addons', 'godot_gsplat'), destinationAddon, { recursive: true });
  fs.copyFileSync(path.join(source, 'LICENSE'), path.join(destinationAddon, 'LICENSE'));
  fs.mkdirSync(destinationReleaseTarget, { recursive: true });
  fs.mkdirSync(destinationDebugTarget, { recursive: true });
  // Godot uses the descriptor's debug entry in Editor builds. The optimized upstream
  // binary is intentional here: large splat decode/build is impractical without it.
  fs.copyFileSync(library, path.join(destinationReleaseTarget, path.basename(library)));
  fs.copyFileSync(library, path.join(destinationDebugTarget, path.basename(library)));
  fs.copyFileSync(path.join(source, 'godot_gsplat.gdextension'), descriptor);

  const buildRecord = [
    `source=${UPSTREAM_URL}`,
    `commit=${UPSTREAM_COMMIT}`,
    `cargo_lock_sha256=${sha256(pinnedLock)}`,
    `compatibility_patch_sha256=${sha256(compatibilityPatch)}`,
    `platform=${process.platform}-${process.arch}`,
    `binary=${path.basename(library)}`,
    `binary_sha256=${sha256(library)}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(destinationAddon, 'SCENESYNC_BUILD.txt'), buildRecord);

  console.log(`Installed godot-gsplat ${UPSTREAM_COMMIT}`);
  console.log(`  project ${options.project}`);
  console.log(`  binary  ${path.join(destinationReleaseTarget, path.basename(library))}`);
  console.log('  renderer Godot Mobile/Forward+ (gl_compatibility is unsupported)');
}

main();
