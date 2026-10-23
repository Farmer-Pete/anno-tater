// What tater knows about each browser: where it keeps its profile and helper manifests, how to
// open a URL in it, which one is the system default, and (Gecko) where it stores our extension's address.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { FIREFOX_ID } from '../shared/protocol.ts';

// Firefox-based browsers must allow unsigned add-ons (xpinstall.signatures.required = false), which
// Zen and Firefox Developer Edition do and regular Firefox doesn't, so regular Firefox isn't listed.
export const BROWSERS = ['chrome', 'zen', 'firefox-dev'] as const;
export type Browser = (typeof BROWSERS)[number];
export const isBrowser = (b: string): b is Browser => (BROWSERS as readonly string[]).includes(b);

interface Info {
  name: string;
  macBundle: string;   // for `open -b` and the default-browser lookup
  linuxDesktop: string; // xdg-settings name
  linuxBinary: string;
  // Relative to home. Zen reads Mozilla's manifest folder like Firefox (zen-browser/desktop#13214).
  dirs: Partial<Record<NodeJS.Platform, { profile: string; hosts: string }>>;
}

const INFO: Record<Browser, Info> = {
  chrome: {
    name: 'Google Chrome', macBundle: 'com.google.chrome', linuxDesktop: 'google-chrome.desktop', linuxBinary: 'google-chrome',
    dirs: {
      darwin: { profile: 'Library/Application Support/Google/Chrome', hosts: 'Library/Application Support/Google/Chrome/NativeMessagingHosts' },
      linux: { profile: '.config/google-chrome', hosts: '.config/google-chrome/NativeMessagingHosts' },
    },
  },
  zen: {
    name: 'Zen', macBundle: 'app.zen-browser.zen', linuxDesktop: 'zen.desktop', linuxBinary: 'zen',
    dirs: {
      darwin: { profile: 'Library/Application Support/zen', hosts: 'Library/Application Support/Mozilla/NativeMessagingHosts' },
      linux: { profile: '.zen', hosts: '.mozilla/native-messaging-hosts' },
    },
  },
  'firefox-dev': {
    name: 'Firefox Developer Edition', macBundle: 'org.mozilla.firefoxdeveloperedition',
    linuxDesktop: 'firefox-developer-edition.desktop', linuxBinary: 'firefox-developer-edition',
    dirs: {
      darwin: { profile: 'Library/Application Support/Firefox', hosts: 'Library/Application Support/Mozilla/NativeMessagingHosts' },
      linux: { profile: '.mozilla/firefox', hosts: '.mozilla/native-messaging-hosts' },
    },
  },
};

export const browserName = (b: Browser) => INFO[b].name;

function dirs(browser: Browser): { profile: string; hosts: string } {
  const d = INFO[browser].dirs[platform()];
  if (!d) throw new Error(`${INFO[browser].name} on ${platform()} isn't supported yet`);
  return { profile: join(homedir(), d.profile), hosts: join(homedir(), d.hosts) };
}

export const hostsDir = (browser: Browser) => dirs(browser).hosts;

// The browsers with a profile on this machine.
export const detected = (): Browser[] => BROWSERS.filter(b => { try { return existsSync(dirs(b).profile); } catch { return false; } });

// The system default browser, when it's one we support; null otherwise (Safari, Arc, ...).
export function defaultBrowser(): Browser | null {
  try {
    if (platform() === 'darwin') {
      const plist = join(homedir(), 'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist');
      const json = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' })) as {
        LSHandlers?: { LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }[];
      };
      const bundle = json.LSHandlers?.find(h => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll?.toLowerCase();
      return BROWSERS.find(b => INFO[b].macBundle === bundle) ?? null;
    }
    const desktop = execFileSync('xdg-settings', ['get', 'default-web-browser'], { encoding: 'utf8' }).trim();
    return BROWSERS.find(b => INFO[b].linuxDesktop === desktop) ?? null;
  } catch {
    return null;
  }
}

export function openIn(browser: Browser, url: string): void {
  if (platform() === 'darwin') execFileSync('open', ['-b', INFO[browser].macBundle, url]);
  else execFileSync(INFO[browser].linuxBinary, [url], { stdio: 'ignore' });
}

// Firefox and Zen give each install of an extension a random host name (moz-extension://<uuid>).
// They record it in the profile's prefs.js under extensions.webextensions.uuids; the default
// profile (installs.ini) is checked first.
export function geckoBase(browser: Browser): string | null {
  if (browser === 'chrome') return null;
  const root = dirs(browser).profile;
  const candidates: string[] = [];
  try {
    const installs = readFileSync(join(root, 'installs.ini'), 'utf8');
    for (const m of installs.matchAll(/^Default=(.+)$/gm)) if (m[1]) candidates.push(join(root, m[1]));
  } catch { /* no installs.ini: fall back to every profile */ }
  try {
    const profiles = join(root, 'Profiles');
    for (const p of readdirSync(profiles)) candidates.push(join(profiles, p));
  } catch { return null; }
  for (const profile of candidates) {
    try {
      const uuids = /user_pref\("extensions\.webextensions\.uuids", "(.*)"\);/.exec(readFileSync(join(profile, 'prefs.js'), 'utf8'))?.[1];
      const uuid = uuids ? (JSON.parse(JSON.parse(`"${uuids}"`) as string) as Record<string, string>)[FIREFOX_ID] : undefined;
      if (uuid) return `moz-extension://${uuid}`;
    } catch { /* unreadable profile: try the next */ }
  }
  return null;
}
