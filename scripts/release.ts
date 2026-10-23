// Publishes GitHub release v<version> with the files install.sh downloads:
// anno-tater-skill.tar.gz (the skill with bundled tater and helper), anno-tater-chrome.zip, and
// anno-tater.xpi (unsigned, for Zen and Firefox Developer Edition).
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
execFileSync('node', ['scripts/build.ts'], { stdio: 'inherit' });

const skill = resolve('dist', 'anno-tater-skill.tar.gz');
const chrome = resolve('dist', 'anno-tater-chrome.zip');
for (const f of [skill, chrome]) rmSync(f, { force: true });
execFileSync('tar', ['-czf', skill, 'skill']);
execFileSync('zip', ['-r', '-X', '-q', chrome, '.'], { cwd: 'dist/chrome' });

const assets = [skill, chrome, resolve('dist', 'anno-tater.xpi')];
execFileSync('gh', ['release', 'create', `v${version}`, '--title', `Anno Tater ${version}`, '--generate-notes', ...assets], { stdio: 'inherit' });
