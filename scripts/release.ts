// Publishes GitHub release v<version> with the three files install.sh downloads:
// anno-tater-skill.tar.gz (the skill with bundled tater and helper), anno-tater-chrome.zip, and
// anno-tater.xpi (signed). Run `npm run sign:firefox` first; this refuses to publish without it.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const signed = resolve('dist', `anno-tater-${version}.xpi`);
if (!existsSync(signed)) throw new Error(`no signed Firefox build for ${version}; run npm run sign:firefox`);

execFileSync('node', ['scripts/build.ts'], { stdio: 'inherit' });
const assets = ['anno-tater-skill.tar.gz', 'anno-tater-chrome.zip', 'anno-tater.xpi'].map(name => resolve('dist', name));
for (const a of assets) rmSync(a, { force: true });

const [skill = '', chrome = '', xpi = ''] = assets;
execFileSync('tar', ['-czf', skill, 'skill']);
execFileSync('zip', ['-r', '-X', '-q', chrome, '.'], { cwd: 'dist/chrome' });
copyFileSync(signed, xpi);

execFileSync('gh', ['release', 'create', `v${version}`, '--title', `Anno Tater ${version}`, '--generate-notes', ...assets], { stdio: 'inherit' });
