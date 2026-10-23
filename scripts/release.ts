// Publishes GitHub release v<version> with the files install.sh downloads:
// anno-tater-skill.tar.gz (the skill with bundled tater and helper), anno-tater-chrome.zip, and,
// when `npm run sign:firefox` has produced one, anno-tater.xpi (signed). Without it, install.sh
// skips Firefox and Zen.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const signed = resolve('dist', `anno-tater-${version}.xpi`);
if (!existsSync(signed)) console.log(`no signed Firefox build for ${version}: releasing for Chrome only`);

execFileSync('node', ['scripts/build.ts'], { stdio: 'inherit' });
const assets = ['anno-tater-skill.tar.gz', 'anno-tater-chrome.zip', 'anno-tater.xpi'].map(name => resolve('dist', name));
for (const a of assets) rmSync(a, { force: true });

const [skill = '', chrome = '', xpi = ''] = assets;
execFileSync('tar', ['-czf', skill, 'skill']);
execFileSync('zip', ['-r', '-X', '-q', chrome, '.'], { cwd: 'dist/chrome' });
if (existsSync(signed)) copyFileSync(signed, xpi);

const files = assets.filter(existsSync);
execFileSync('gh', ['release', 'create', `v${version}`, '--title', `Anno Tater ${version}`, '--generate-notes', ...files], { stdio: 'inherit' });
