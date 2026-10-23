// Registers the helper with the browsers: a launcher script plus one host manifest per browser.
// Browsers won't let an extension write these files, so a person runs `tater install` once.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_ID, FIREFOX_ID, HOST_NAME } from '../shared/protocol.ts';
import { dataDir } from './store.ts';

export const BROWSERS = ['chrome', 'firefox', 'zen'] as const;
export type Browser = (typeof BROWSERS)[number];

// Each browser's profile folder, and where it reads per-user host manifests. Zen (a Firefox fork)
// reads Mozilla's folder like Firefox does (zen-browser/desktop#13214), so the two share one
// manifest. Windows uses the registry instead and isn't supported yet.
const FOLDERS: Partial<Record<NodeJS.Platform, Record<Browser, { app: string; hosts: string } | null>>> = {
  darwin: {
    chrome: { app: 'Library/Application Support/Google/Chrome', hosts: 'Library/Application Support/Google/Chrome/NativeMessagingHosts' },
    firefox: { app: 'Library/Application Support/Firefox', hosts: 'Library/Application Support/Mozilla/NativeMessagingHosts' },
    zen: { app: 'Library/Application Support/zen', hosts: 'Library/Application Support/Mozilla/NativeMessagingHosts' },
  },
  linux: {
    chrome: { app: '.config/google-chrome', hosts: '.config/google-chrome/NativeMessagingHosts' },
    firefox: { app: '.mozilla', hosts: '.mozilla/native-messaging-hosts' },
    zen: null,
  },
};

function folders(browser: Browser): { app: string; hosts: string } {
  const f = FOLDERS[platform()]?.[browser];
  if (!f) throw new Error(`installing the helper for ${browser} on ${platform()} isn't supported yet`);
  return { app: join(homedir(), f.app), hosts: join(homedir(), f.hosts) };
}
const manifestDir = (browser: Browser) => folders(browser).hosts;

// The browsers with a profile on this machine, for a default install.
export const detected = (): Browser[] => BROWSERS.filter(b => { try { return existsSync(folders(b).app); } catch { return false; } });

const manifestPath = (browser: Browser) => join(manifestDir(browser), `${HOST_NAME}.json`);
const binDir = () => join(dataDir(), 'bin');
const launcherPath = () => join(binDir(), 'anno-tater-host');
export const cliPath = () => join(binDir(), 'tater');

// The node on PATH, as a path that survives upgrades (Homebrew's /opt/homebrew/bin/node, not the
// versioned Cellar path that process.execPath resolves to).
function nodePath(): string {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const candidate = join(dir, 'node');
    if (dir && existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

// The browser starts the launcher without a shell PATH, so it names node and the script by absolute path.
function writeLauncher(path: string, script: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec "${nodePath()}" --disable-warning=ExperimentalWarning "${fileURLToPath(new URL(script, import.meta.url))}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

// Writes the helper's launcher and manifests, plus a `tater` launcher at a fixed path for agents.
export function install(browsers: Browser[]): string[] {
  writeLauncher(cliPath(), '../cli/tater.ts');
  const path = writeLauncher(launcherPath(), './main.ts');
  return browsers.map(browser => {
    const manifest = {
      name: HOST_NAME,
      description: 'Anno Tater helper: carries notes and replies between agents and the browser.',
      path,
      type: 'stdio',
      // Firefox and Zen name the extension by its add-on id; Chrome by its extension origin.
      ...(browser === 'chrome' ? { allowed_origins: [`chrome-extension://${CHROME_ID}/`] } : { allowed_extensions: [FIREFOX_ID] }),
    };
    const file = manifestPath(browser);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return file;
  });
}

export function uninstall(browsers: Browser[]): string[] {
  const removed = browsers.map(manifestPath).filter(existsSync);
  for (const file of removed) rmSync(file);
  if (BROWSERS.every(b => !installed(b))) for (const f of [launcherPath(), cliPath()]) rmSync(f, { force: true });
  return removed;
}

export const installed = (browser: Browser) => { try { return existsSync(manifestPath(browser)); } catch { return false; } };
