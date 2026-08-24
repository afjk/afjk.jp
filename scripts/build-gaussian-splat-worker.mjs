// Builds the vendored Gaussian Splat conversion Worker.
//
// SceneSync is served as static files, so a bare `import '@playcanvas/splat-transform'`
// never resolves in a browser. Rather than reaching for a CDN at runtime, the
// library is bundled here, at a version pinned by package-lock.json, and the
// result is committed under html/assets/vendor/ alongside Rapier and Loomlet.
//
//   npm run build:gaussian-splat-worker
//
// The build is verified before it is written: the freshly built bundle converts
// each fixture format and its output is checked with SceneSync's own KHR
// inspector, so a bundle that cannot do its job never lands in the tree.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import esbuild from 'esbuild';

import { loadVendoredSplatBundle } from './lib/load-vendored-splat-bundle.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGE_NAME = '@playcanvas/splat-transform';
const ENTRY = 'html/assets/js/scenesync/loaders/gaussian-splat/gaussian-splat-import.worker.js';
const BUNDLE_BASENAME = 'gaussian-splat-import.worker.js';

/**
 * The library statically imports playcanvas, and Emscripten glue reaches for
 * Node builtins behind `ENVIRONMENT_IS_NODE` checks that are false in a
 * browser. Resolving them to an empty module keeps the dead branches
 * bundleable without changing what actually runs.
 */
const stubNodeBuiltins = {
  name: 'stub-node-builtins',
  setup(build) {
    const filter = /^(node:)?(module|worker_threads|os|fs|path|url|crypto|util|stream|zlib|child_process)$/;
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'node-stub' }));
    build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
      contents: 'export default {}; export const parentPort = null;',
      loader: 'js',
    }));
  },
};

/**
 * splat-transform embeds the whole SuperSplat viewer — a second copy of the
 * PlayCanvas engine, as a string — for its `html` output format. SceneSync only
 * ever writes GLB, so those literals are dead weight that would more than
 * double the bundle.
 */
const MIN_STRIPPED_LITERAL_BYTES = 100_000;

/**
 * The Emscripten glue around webp.wasm picks its I/O strategy from
 * `ENVIRONMENT_IS_NODE`, and its Node branch calls `createRequire` — which the
 * builtin stubs above cannot provide. This is a browser bundle, so pinning the
 * flag to false is simply the truth, and it is what lets the bundle be
 * exercised outside a browser at all.
 */
const NODE_ENVIRONMENT_FLAG = 'var ENVIRONMENT_IS_NODE=typeof process=="object"&&process.versions?.node&&process.type!="renderer";';

/**
 * Rewrite splat-transform's ESM entry for the browser. Both edits are
 * asserted: if either stops matching the build fails rather than silently
 * shipping a bundle that is twice the size, or one that takes a Node code path
 * in a Worker.
 */
function makeRetargetForBrowser(report) {
  return {
    name: 'retarget-splat-transform-for-browser',
    setup(build) {
      // The ESM entry specifically: index.cjs is never in this graph, and the
      // spz chunk next to it must not be touched.
      const filter = /[\\/]@playcanvas[\\/]splat-transform[\\/]dist[\\/]index\.mjs$/;

      build.onLoad({ filter }, async (args) => {
        const source = await fs.readFile(args.path, 'utf8');

        // Only double-quoted top-level literals: the spz decoder embeds its
        // wasm in a single-quoted literal and must survive untouched.
        const pattern = /(var|const|let)(\s+[\w$]+\s*=\s*)"((?:[^"\\]|\\.)*)"/g;
        let contents = source.replace(pattern, (match, keyword, binding, literal) => {
          if (literal.length < MIN_STRIPPED_LITERAL_BYTES) return match;
          report.stripped.push({ binding: binding.trim().replace(/\s*=$/, ''), bytes: literal.length });
          return `${keyword}${binding}""`;
        });

        if (contents.includes(NODE_ENVIRONMENT_FLAG)) {
          contents = contents.replaceAll(NODE_ENVIRONMENT_FLAG, 'var ENVIRONMENT_IS_NODE=false;');
          report.pinnedNodeFlag = true;
        }

        return { contents, loader: 'js' };
      });
    },
  };
}

async function build(outDir) {
  const report = { stripped: [], pinnedNodeFlag: false };
  const result = await esbuild.build({
    entryPoints: [path.join(repoRoot, ENTRY)],
    outfile: path.join(outDir, BUNDLE_BASENAME),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    define: { __SPLAT_TRANSFORM_BUNDLED__: 'true' },
    plugins: [makeRetargetForBrowser(report), stubNodeBuiltins],
    metafile: true,
  });

  if (report.stripped.length === 0) {
    throw new Error(
      `${PACKAGE_NAME} no longer embeds the SuperSplat viewer as a large string literal. `
      + 'Check whether the strip is still needed and update scripts/build-gaussian-splat-worker.mjs.',
    );
  }
  if (!report.pinnedNodeFlag) {
    throw new Error(
      `${PACKAGE_NAME}'s Emscripten environment check no longer matches the expected source. `
      + 'Update NODE_ENVIRONMENT_FLAG in scripts/build-gaussian-splat-worker.mjs.',
    );
  }

  return { result, stripped: report.stripped };
}

const FIXTURES = [
  { name: 'ring-gaussian-splats.ply', sourceFormat: 'ply' },
  { name: 'ring-gaussian-splats.spz', sourceFormat: 'spz' },
  { name: 'ring-gaussian-splats.sog', sourceFormat: 'sog' },
  { name: 'ring-gaussian-splats.lcc2.zip', sourceFormat: 'lcc2' },
];

/** Run the built bundle against every fixture format before committing it. */
async function verify(bundlePath) {
  const { inspectGaussianSplatGlb } = await import(
    pathToFileURL(path.join(repoRoot, 'html/assets/js/scenesync/loaders/khr-gaussian-splatting.js')).href
  );
  const bundle = await loadVendoredSplatBundle({ bundlePath, fresh: true });

  const fixtureDir = path.join(repoRoot, 'html/scenesync/experiments/fixtures');
  for (const fixture of FIXTURES) {
    const bytes = new Uint8Array(await fs.readFile(path.join(fixtureDir, fixture.name)));
    const converted = await bundle.convertGaussianSplatToGlb(bytes, { fileName: fixture.name });

    if (converted.sourceFormat !== fixture.sourceFormat) {
      throw new Error(
        `${fixture.name}: expected sourceFormat ${fixture.sourceFormat}, got ${converted.sourceFormat}`,
      );
    }
    if (converted.splatCount === 0) throw new Error(`${fixture.name}: converted to zero splats`);
    if (!inspectGaussianSplatGlb(converted.glb).valid) {
      throw new Error(`${fixture.name}: bundle produced a GLB that fails KHR inspection`);
    }
    console.log(`  verified ${fixture.name} -> ${converted.splatCount} splats, ${converted.glb.byteLength} B GLB`);
  }
}

const version = JSON.parse(
  await fs.readFile(path.join(repoRoot, 'node_modules', PACKAGE_NAME, 'package.json'), 'utf8'),
).version;

const pinned = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  .dependencies?.[PACKAGE_NAME];
if (pinned !== version) {
  throw new Error(
    `Installed ${PACKAGE_NAME} is ${version} but package.json pins ${pinned}. Run npm ci first.`,
  );
}

const outDir = path.join(repoRoot, 'html/assets/vendor/splat-transform', version);
await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const { result, stripped } = await build(outDir);

// SOG decoding needs the WebP wasm at runtime; the bundle looks for it here.
await fs.copyFile(
  path.join(repoRoot, 'node_modules', PACKAGE_NAME, 'lib/webp.wasm'),
  path.join(outDir, 'webp.wasm'),
);

const bundlePath = path.join(outDir, BUNDLE_BASENAME);
const bundleBytes = (await fs.stat(bundlePath)).size;

console.log(`Built ${PACKAGE_NAME}@${version} worker bundle`);
for (const entry of stripped) {
  console.log(`  stripped ${entry.binding} (${(entry.bytes / 1024 / 1024).toFixed(2)} MB of embedded viewer)`);
}
console.log(`  ${path.relative(repoRoot, bundlePath)}: ${(bundleBytes / 1024 / 1024).toFixed(2)} MB`);

const outputs = Object.keys(result.metafile.outputs);
if (outputs.length !== 1) {
  throw new Error(`Expected a single bundle output, got: ${outputs.join(', ')}`);
}

await verify(bundlePath);

const source = await fs.readFile(bundlePath, 'utf8');
for (const forbidden of ['cdn.jsdelivr', 'unpkg.com', 'rawcdn.githack']) {
  if (source.includes(forbidden)) {
    throw new Error(`Vendored bundle must not reference ${forbidden}`);
  }
}

console.log('Bundle verified.');
