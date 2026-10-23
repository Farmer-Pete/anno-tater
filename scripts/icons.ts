// Writes icons/potato.svg from src/engine/potato.ts and renders the PNG sizes Chrome needs.
// macOS only (QuickLook renders the SVG, sips resizes). Run it after changing the potato; the
// outputs are committed so the build doesn't need it.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { potatoSvg } from '../src/engine/potato.ts';

const svgPath = join('icons', 'potato.svg');
writeFileSync(svgPath, `${potatoSvg()}\n`);
const tmp = mkdtempSync(join(tmpdir(), 'anno-tater-icons-'));
execFileSync('qlmanage', ['-t', '-s', '512', '-o', tmp, svgPath], { stdio: 'ignore' });
const big = join(tmp, 'potato.svg.png');
for (const size of [16, 32, 48, 128]) {
  const out = join(tmp, `${size}.png`);
  execFileSync('sips', ['-z', String(size), String(size), big, '--out', out], { stdio: 'ignore' });
  renameSync(out, join('icons', `${size}.png`));
}
console.log('wrote icons/potato.svg and icons/{16,32,48,128}.png');
