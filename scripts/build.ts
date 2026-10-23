// Builds the extension for Chrome and Firefox into dist/<browser>/.
// esbuild bundles each entry point; the manifest is the base plus the browser's overrides.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

for (const browser of ['chrome', 'firefox'] as const) {
  const out = join('dist', browser);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'icons'), { recursive: true });

  await build({
    entryPoints: ['background', 'content', 'popup', 'open'].map(name => join('src', 'extension', `${name}.ts`)),
    outdir: out,
    bundle: true,
    format: 'iife',
    target: browser === 'chrome' ? 'chrome120' : 'firefox140',
    legalComments: 'none',
    logLevel: 'warning',
  });

  const manifest = { ...readJson('manifest/base.json'), ...readJson(`manifest/${browser}.json`), version: pkg.version };
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join('src', 'extension', 'static'), out, { recursive: true });
  cpSync('icons', join(out, 'icons'), { recursive: true });
}
// The agent side for the skill: tater and the helper as plain JavaScript that runs on Node 20+,
// so installing the skill needs no clone and no Node 26.
await build({
  entryPoints: { tater: 'src/cli/tater.ts', host: 'src/host/main.ts' },
  outdir: join('skill', 'bin'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  logLevel: 'warning',
});
console.log('built dist/chrome, dist/firefox, and skill/bin');
