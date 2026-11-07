// Builds the release files into dist/release: the skill with bundled tater and helper, the Chrome
// extension, the unsigned add-on for Zen and Firefox Developer Edition, and install.sh pinned to
// this version, plus SHA256SUMS over all of them. The Release workflow runs it on a version tag,
// attests each file, and publishes them; install.sh checks every download against SHA256SUMS.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
execFileSync('node', ['scripts/build.ts'], { stdio: 'inherit' });

const out = resolve('dist', 'release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync('tar', ['-czf', join(out, 'anno-tater-skill.tar.gz'), 'skill']);
execFileSync('zip', ['-r', '-X', '-q', join(out, 'anno-tater-chrome.zip'), '.'], { cwd: join('dist', 'chrome') });
copyFileSync(join('dist', 'anno-tater.xpi'), join(out, 'anno-tater.xpi'));
const script = readFileSync('install.sh', 'utf8');
if (!/^TAG=latest$/m.test(script)) throw new Error('install.sh has no TAG=latest line to pin');
writeFileSync(join(out, 'install.sh'), script.replace(/^TAG=latest$/m, `TAG=v${version}`), { mode: 0o755 });

const files = ['anno-tater-skill.tar.gz', 'anno-tater-chrome.zip', 'anno-tater.xpi', 'install.sh'];
const sum = (f: string) => createHash('sha256').update(readFileSync(join(out, f))).digest('hex');
writeFileSync(join(out, 'SHA256SUMS'), files.map(f => `${sum(f)}  ${f}\n`).join(''));
console.log(`packaged v${version} in dist/release: ${[...files, 'SHA256SUMS'].join(', ')}`);
