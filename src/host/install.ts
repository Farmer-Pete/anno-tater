// Registers the helper with the browsers: a launcher script plus one host manifest per browser.
// Browsers won't let an extension write these files, so a person runs `tater install` once.
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME_ID, FIREFOX_ID, HOST_NAME } from '../shared/protocol.ts';
import { dataDir } from './store.ts';

export type Browser = 'chrome' | 'firefox';

// Per-user host manifest folders. Windows uses the registry instead and isn't supported yet.
function manifestDir(browser: Browser): string {
  const home = homedir();
  if (platform() === 'darwin') {
    return browser === 'chrome'
      ? join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
      : join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts');
  }
  if (platform() === 'linux') {
    return browser === 'chrome' ? join(home, '.config/google-chrome/NativeMessagingHosts') : join(home, '.mozilla/native-messaging-hosts');
  }
  throw new Error(`installing the helper on ${platform()} isn't supported yet`);
}

const manifestPath = (browser: Browser) => join(manifestDir(browser), `${HOST_NAME}.json`);
const launcherPath = () => join(dataDir(), 'bin', 'anno-tater-host');

// The browser starts the launcher without a shell PATH, so it names node and the script by absolute path.
function writeLauncher(): string {
  const script = fileURLToPath(new URL('./main.ts', import.meta.url));
  const path = launcherPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${script}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

export function install(browsers: Browser[]): string[] {
  const path = writeLauncher();
  return browsers.map(browser => {
    const manifest = {
      name: HOST_NAME,
      description: 'Anno Tater helper: carries notes and replies between agents and the browser.',
      path,
      type: 'stdio',
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
  if (browsers.length === 2) rmSync(launcherPath(), { force: true });
  return removed;
}

export const installed = (browser: Browser) => existsSync(manifestPath(browser));
