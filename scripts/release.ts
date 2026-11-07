// Releases v<version> from package.json: tags this commit with a signed tag and pushes the tag.
// The Release workflow then checks, builds, attests, and publishes the files install.sh
// downloads (scripts/package.ts). Bump package.json's version first.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const tag = `v${version}`;
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) throw new Error('commit or stash your changes first: the tag names this commit');
git('fetch', '--quiet', 'origin', 'main');
try { git('merge-base', '--is-ancestor', 'HEAD', 'origin/main'); } catch { throw new Error('release from a commit on origin/main: the Release workflow refuses any other'); }
execFileSync('git', ['tag', '-s', tag, '-m', `Anno Tater ${version}`], { stdio: 'inherit' }); // the signer may prompt
execFileSync('git', ['push', 'origin', tag], { stdio: 'inherit' });
console.log(`pushed ${tag}; the Release workflow publishes it`);
