// The extension's background: talks to the helper (when installed), answers pages asking for
// their notes, registers the content script for allowed sites, and drives the toolbar badge.
import { comparableUrl, originPattern, pickLayers, type NotesFile } from '../shared/notes.ts';
import { HOST_NAME, type FromHost, type PageSummary } from '../shared/protocol.ts';
import { ext, type FromPage, type PopupState, type Request, type ToPage } from './compat.ts';
import { localPages } from './local.ts';

type Port = chrome.runtime.Port;

// ---------- helper ----------
let helper: Port | null = null;
let helperState: PopupState['helper'] = 'unknown';
let helperError = '';
let helperPages: PageSummary[] = [];
const delivered = new Set<string>();
const waiting = new Map<string, ((notes: NotesFile | null) => void)[]>();

function connectHelper(): void {
  if (helper) return;
  try {
    helper = ext.runtime.connectNative(HOST_NAME);
  } catch (e) {
    helperState = 'missing';
    helperError = (e as Error).message;
    return;
  }
  helper.onMessage.addListener(onHelper);
  helper.onDisconnect.addListener(() => {
    // Chrome reports the reason in runtime.lastError; Firefox puts it on the port.
    const gecko = (helper as { error?: { message: string } } | null)?.error;
    helperError = ext.runtime.lastError?.message ?? gecko?.message ?? 'the helper stopped';
    helper = null;
    helperState = 'missing';
    for (const resolvers of waiting.values()) for (const r of resolvers) r(null);
    waiting.clear();
    broadcast({ type: 'twoWay', on: false });
    void updateBadge();
  });
}

function onHelper(raw: unknown): void {
  const m = raw as FromHost;
  if (m.type === 'hello') {
    helperState = 'connected';
    helperError = '';
    helperPages = m.pages;
    m.delivered.forEach(id => delivered.add(id));
    for (const port of pages.keys()) void refresh(port);
    void updateBadge();
  } else if (m.type === 'pages') {
    helperPages = m.pages;
    // Re-send notes to every open page whose layers changed: a file was added, removed, or edited.
    for (const [port, info] of pages) if (layerKey(pickLayers(helperPages, info.url)) !== info.layers) void refresh(port);
    void updateBadge();
  } else if (m.type === 'notes') {
    const key = `${m.channel}|${m.match}`;
    for (const r of waiting.get(key) ?? []) r(m.notes ? { ...m.notes, channel: m.channel } : null);
    waiting.delete(key);
  } else if (m.type === 'delivered') {
    m.ids.forEach(id => delivered.add(id));
    broadcast({ type: 'delivered', ids: m.ids });
  } else if (m.type === 'error') {
    console.warn('Anno Tater helper:', m.message);
  }
}

function askHelper(channel: string, match: string): Promise<NotesFile | null> {
  return new Promise(resolve => {
    if (!helper) { resolve(null); return; }
    const key = `${channel}|${match}`;
    waiting.set(key, [...(waiting.get(key) ?? []), resolve]);
    helper.postMessage({ type: 'get', channel, match });
  });
}

// ---------- notes lookup ----------
// Identifies which files make up a page's layers, so a change to any of them is noticed.
const layerKey = (layers: { channel?: string; match: string; rev?: number }[]) =>
  layers.map(l => `${l.channel}|${l.match}|${l.rev ?? 0}`).join(' ');

// Every channel's layer for a page, newest first. The helper's files win over notes the intake
// page stored for the same channel.
async function layersFor(url: string): Promise<NotesFile[]> {
  const fromHelper = helper ? pickLayers(helperPages, url) : [];
  const fetched = (await Promise.all(fromHelper.map(p => askHelper(p.channel, p.match)))).filter((n): n is NotesFile => n !== null);
  const seen = new Set(fetched.map(n => n.channel));
  const local = pickLayers(Object.values(await localPages()), url).filter(n => !seen.has(n.channel));
  return [...fetched, ...local];
}

// The channel that most recently wrote notes: where a question about a page with no notes goes.
const newestChannel = () => helperPages.toSorted((a, b) => b.rev - a.rev)[0]?.channel;

// ---------- pages ----------
const pages = new Map<Port, { url: string; layers: string; count: number; tabId: number | undefined }>();
const activated = new Set<number>(); // tabs where the person asked to talk about a page with no notes
const broadcast = (m: ToPage) => { for (const port of pages.keys()) port.postMessage(m); };

async function refresh(port: Port): Promise<void> {
  const info = pages.get(port);
  if (!info) return;
  const layers = await layersFor(info.url);
  info.layers = layerKey(pickLayers(helperPages, info.url));
  const channel = newestChannel();
  if (!layers.length && channel && info.tabId !== undefined && activated.has(info.tabId)) {
    layers.push({ channel, match: comparableUrl(info.url), url: info.url, notes: [] });
  }
  info.count = layers.reduce((n, l) => n + l.notes.length, 0);
  const message: ToPage = { type: 'notes', layers, twoWay: helperState === 'connected', delivered: [...delivered] };
  try { port.postMessage(message); } catch { pages.delete(port); }
}

ext.runtime.onConnect.addListener(port => {
  if (port.name !== 'page') return;
  connectHelper(); // installed since the browser started? pick it up without a restart
  pages.set(port, { url: '', layers: '', count: 0, tabId: port.sender?.tab?.id });
  port.onDisconnect.addListener(() => pages.delete(port));
  port.onMessage.addListener(raw => {
    const m = raw as FromPage;
    const info = pages.get(port);
    if (!info) return;
    if (m.type === 'hello') { info.url = m.url; void refresh(port); }
    else if (m.type === 'send') helper?.postMessage({ type: 'send', message: m.message });
  });
});

// ---------- site access ----------
async function grantedOrigins(): Promise<string[]> {
  const { origins = [] } = await ext.permissions.getAll();
  return origins.filter(o => /^https?:\/\//.test(o));
}

const SCRIPT_ID = 'anno-tater';
async function syncContentScripts(): Promise<void> {
  const matches = await grantedOrigins();
  const existing = await ext.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  if (existing.length) await ext.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  if (matches.length) {
    await ext.scripting.registerContentScripts([{ id: SCRIPT_ID, matches, js: ['content.js'], runAt: 'document_start' }]);
  }
}

// Pages already open on a newly allowed site don't have the content script yet.
async function injectInto(origins: string[]): Promise<void> {
  if (!origins.length) return;
  for (const tab of await ext.tabs.query({ url: origins })) {
    if (tab.id !== undefined) await ext.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
  }
}

async function needsAccess(): Promise<PopupState['needsAccess']> {
  const granted = new Set(await grantedOrigins());
  const all = [...helperPages, ...Object.values(await localPages())];
  const out = new Map<string, PopupState['needsAccess'][number]>();
  for (const p of all) {
    const origin = p.url ? originPattern(p.url) : null;
    if (!origin || granted.has(origin)) continue;
    const row = out.get(origin) ?? { origin, host: new URL(p.url ?? '').hostname, titles: [] };
    row.titles.push(p.title ?? p.match);
    out.set(origin, row);
  }
  return [...out.values()];
}

async function updateBadge(): Promise<void> {
  const n = (await needsAccess()).length;
  await ext.action.setBadgeBackgroundColor({ color: '#8250df' });
  await ext.action.setBadgeText({ text: n ? String(n) : '' });
  await ext.action.setTitle({ title: n ? `Anno Tater: ${n} site${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} access` : 'Anno Tater' });
}

ext.permissions.onAdded.addListener(p => { void syncContentScripts().then(() => injectInto(p.origins ?? [])).then(updateBadge); });
ext.permissions.onRemoved.addListener(() => { void syncContentScripts().then(updateBadge); });

// ---------- popup and intake page ----------
ext.runtime.onMessage.addListener((raw, _sender, reply) => {
  const m = raw as Request;
  if (m.type === 'popup') {
    connectHelper();
    void (async () => {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      const port = [...pages].find(([, i]) => i.tabId === tab?.id);
      const tabNotes = port?.[1].layers || port?.[1].count ? port[1].count : null;
      const state: PopupState = { helper: helperState, helperError, needsAccess: await needsAccess(), tabNotes };
      reply(state);
    })();
    return true; // reply is async
  }
  if (m.type === 'activate') {
    activated.add(m.tabId);
    void ext.scripting.executeScript({ target: { tabId: m.tabId }, files: ['content.js'] }).then(() => {
      for (const [port, info] of pages) if (info.tabId === m.tabId) void refresh(port);
    });
  } else if (m.type === 'toggle-hidden') {
    for (const [port, info] of pages) if (info.tabId === m.tabId) port.postMessage({ type: 'toggle-hidden' } satisfies ToPage);
  } else if (m.type === 'granted') {
    void syncContentScripts().then(updateBadge);
  }
  return false;
});

ext.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.pages) void updateBadge(); });

// The helper stays connected while the browser runs, so notes pushed for a new site raise the badge
// even when no page is open. In Chrome an open native port also keeps this worker awake.
connectHelper();
void syncContentScripts().then(updateBadge);
