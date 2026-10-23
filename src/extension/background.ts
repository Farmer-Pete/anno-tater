// The extension's background: talks to the helper (when installed), answers pages asking for
// their notes, registers the content script for allowed sites, and drives the toolbar badge.
// A page's URL is its key: one notes file, one shared state, and one conversation per page.
import { originPattern, pageKey } from '../shared/notes.ts';
import { HOST_NAME, type FromHost, type PageSummary } from '../shared/protocol.ts';
import { ext, type FromPage, type PopupState, type Request, type ToPage } from './compat.ts';
import { localPages, localState, saveLocalState } from './local.ts';

type Port = chrome.runtime.Port;
type PageReply = Extract<FromHost, { type: 'page' }>;

// ---------- helper ----------
let helper: Port | null = null;
let helperState: PopupState['helper'] = 'unknown';
let helperError = '';
let helperPages: PageSummary[] = [];
const delivered = new Set<string>();
const waiting = new Map<string, ((reply: PageReply | null) => void)[]>();

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

const revOf = (page: string) => helperPages.find(p => p.page === page)?.rev ?? 0;

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
    // Re-send every open page whose notes, shared state, or inbox changed (from any browser).
    for (const [port, info] of pages) if (revOf(info.page) !== info.rev) void refresh(port);
    void updateBadge();
  } else if (m.type === 'page') {
    for (const r of waiting.get(m.page) ?? []) r(m);
    waiting.delete(m.page);
  } else if (m.type === 'delivered') {
    m.ids.forEach(id => delivered.add(id));
    broadcast({ type: 'delivered', ids: m.ids });
  } else if (m.type === 'error') {
    console.warn('Anno Tater helper:', m.message);
  }
}

function askHelper(page: string): Promise<PageReply | null> {
  return new Promise(resolve => {
    if (!helper) { resolve(null); return; }
    waiting.set(page, [...(waiting.get(page) ?? []), resolve]);
    helper.postMessage({ type: 'get', page });
  });
}

// ---------- pages ----------
const pages = new Map<Port, { url: string; page: string; rev: number; count: number | null; tabId: number | undefined }>();
const activated = new Set<number>(); // tabs where the person asked to talk about a page with no notes
const broadcast = (m: ToPage) => { for (const port of pages.keys()) port.postMessage(m); };

// The page's notes, state, and waiting messages: from the helper when it runs, else from this browser.
async function refresh(port: Port): Promise<void> {
  const info = pages.get(port);
  if (!info) return;
  info.rev = revOf(info.page);
  const fromHelper = helper ? await askHelper(info.page) : null;
  let notes = fromHelper ? fromHelper.notes : (await localPages())[info.page] ?? null;
  const state = fromHelper?.state ?? await localState(info.page);
  if (!notes && info.tabId !== undefined && activated.has(info.tabId)) notes = { url: info.url, notes: [] };
  info.count = notes ? notes.notes.length : null;
  const message: ToPage = { type: 'page', notes, state, pending: fromHelper?.pending ?? [], twoWay: helperState === 'connected', delivered: [...delivered] };
  try { port.postMessage(message); } catch { pages.delete(port); }
}

ext.runtime.onConnect.addListener(port => {
  if (port.name !== 'page') return;
  connectHelper(); // installed since the browser started? pick it up without a restart
  pages.set(port, { url: '', page: '', rev: 0, count: null, tabId: port.sender?.tab?.id });
  port.onDisconnect.addListener(() => pages.delete(port));
  port.onMessage.addListener(raw => {
    const m = raw as FromPage;
    const info = pages.get(port);
    if (!info) return;
    if (m.type === 'hello') { info.url = m.url; info.page = pageKey(m.url); void refresh(port); }
    else if (m.type === 'send') helper?.postMessage({ type: 'send', message: m.message });
    else if (helper) helper.postMessage({ type: 'state', page: info.page, state: m.state });
    else void saveLocalState(info.page, m.state);
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
    const origin = originPattern(p.url);
    if (!origin || granted.has(origin)) continue;
    const row = out.get(origin) ?? { origin, host: new URL(p.url).hostname, titles: [] };
    row.titles.push(p.title ?? pageKey(p.url));
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
      const tabNotes = port?.[1].count ?? null;
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
