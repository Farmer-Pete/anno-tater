// Registers the helper with the browsers: launcher scripts plus one host manifest per browser.
// Browsers won't let an extension write these files, so a person runs `tater install` once.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_ID, FIREFOX_ID, HOST_NAME } from '../shared/protocol.ts';
import { BROWSERS, hostsDir, type Browser } from './browsers.ts';
import { dataDir } from './store.ts';

const binDir = () => join(dataDir(), 'bin');
const hostPath = () => join(binDir(), 'anno-tater-host');
export const cliPath = () => join(binDir(), 'tater');
const manifestPath = (browser: Browser) => join(hostsDir(browser), `${HOST_NAME}.json`);

// The node on PATH, as a path that survives upgrades (Homebrew's /opt/homebrew/bin/node, not the
// versioned Cellar path that process.execPath resolves to).
function nodePath(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'node');
    if (dir && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

// Run from the skill's bundle, tater copies the bundled CLI and helper into the data folder, so
// updating or moving the skill can't break the browsers' manifests. Run from a clone, the
// launchers point at the TypeScript sources instead.
function programs(): { cli: string; host: string; flags: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  if (import.meta.url.endsWith('.mjs')) {
    mkdirSync(binDir(), { recursive: true });
    for (const name of ['tater.mjs', 'host.mjs']) {
      if (join(here, name) !== join(binDir(), name)) copyFileSync(join(here, name), join(binDir(), name));
    }
    return { cli: join(binDir(), 'tater.mjs'), host: join(binDir(), 'host.mjs'), flags: '' };
  }
  return { cli: join(here, '../cli/tater.ts'), host: join(here, 'main.ts'), flags: ' --disable-warning=ExperimentalWarning' };
}

// The browser starts the launcher without a shell PATH, so it names node and the script by absolute path.
function writeLauncher(path: string, script: string, flags: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec "${nodePath()}"${flags} "${script}" "$@"\n`);
  chmodSync(path, 0o755);
}

// Writes the launchers and one manifest per browser; returns the manifests written. Firefox and
// Zen share Mozilla's folder, so they share one manifest.
export function install(browsers: Browser[]): string[] {
  const { cli, host, flags } = programs();
  writeLauncher(cliPath(), cli, flags);
  writeLauncher(hostPath(), host, flags);
  const files = new Map(browsers.map(b => [manifestPath(b), b] as const));
  return [...files].map(([file, browser]) => {
    const manifest = {
      name: HOST_NAME,
      description: 'Anno Tater helper: carries notes and replies between agents and the browser.',
      path: hostPath(),
      type: 'stdio',
      // Firefox and Zen name the extension by its add-on id; Chrome by its extension origin.
      ...(browser === 'chrome' ? { allowed_origins: [`chrome-extension://${CHROME_ID}/`] } : { allowed_extensions: [FIREFOX_ID] }),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return file;
  });
}

export function uninstall(browsers: Browser[]): string[] {
  const removed = [...new Set(browsers.map(manifestPath))].filter(existsSync);
  for (const file of removed) rmSync(file);
  if (BROWSERS.every(b => !installed(b))) rmSync(binDir(), { recursive: true, force: true });
  return removed;
}

export const installed = (browser: Browser) => { try { return existsSync(manifestPath(browser)); } catch { return false; } };
