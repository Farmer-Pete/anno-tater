// The extension's background: talks to the helper (when installed), answers pages asking for
// their notes, registers the content script for allowed sites, and drives the toolbar badge.
// A page's URL is its key: one notes file, one shared state, and one conversation per page.
import { originPattern, pageKey } from '../shared/notes.ts';
import { HOST_NAME, type FromHost, type PageSummary } from '../shared/protocol.ts';
import { ext, type FromPage, type PopupState, type Request, type ToPage } from './compat.ts';
import { localPages, localState, migrateLocal, saveLocalState } from './local.ts';

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
    // The helper couldn't read or send a page: stop waiting for it.
    if (m.page) {
      for (const r of waiting.get(m.page) ?? []) r(null);
      waiting.delete(m.page);
    }
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
const sameOrigin = (url: string, sender: string | undefined) => {
  try { return sender !== undefined && originPattern(url) !== null && new URL(url).origin === new URL(sender).origin; } catch { return false; }
};
// page: the page the content script is on; shown: the page whose notes it was last sent.
const pages = new Map<Port, { url: string; page: string; shown: string; rev: number; count: number | null; tabId: number | undefined }>();
const activated = new Map<number, string>(); // tabs where the person asked to talk about a page with no notes, and that page
const focusing = new Map<number, { page: string; note: string }>(); // tabs opened from a link, and the note to show
const broadcast = (m: ToPage) => { for (const port of pages.keys()) port.postMessage(m); };

// This browser's own copies move to the current page keys once; pages wait for that before
// reading them. A failure is reported and leaves the copies as they were.
const localReady = migrateLocal().catch((e: unknown) => { console.warn('Anno Tater: could not update stored notes:', e); });

// The page's notes, state, and waiting messages: from the helper when it runs, else from this browser.
async function refresh(port: Port): Promise<void> {
  const info = pages.get(port);
  if (!info) return;
  await localReady;
  const { page, url } = info; // a single-page app can move on while we wait
  info.rev = revOf(page);
  const fromHelper = helper ? await askHelper(page) : null;
  // A failed read with the helper still connected shows nothing: this browser's copy is stale, and
  // the page's state writes would go to the helper.
  const failed = !fromHelper && helper !== null;
  let notes = fromHelper ? fromHelper.notes : failed ? null : (await localPages())[page] ?? null;
  const state = fromHelper?.state ?? (failed ? { done: {} } : await localState(page));
  // The page moved on while we waited: the newer refresh answers it.
  if (info.page !== page) return;
  // Asking about a page holds for that page only: the tab moving on ends it.
  if (info.tabId !== undefined && activated.has(info.tabId) && activated.get(info.tabId) !== page) activated.delete(info.tabId);
  if (!notes && info.tabId !== undefined && activated.has(info.tabId)) notes = { url, notes: [] };
  info.count = notes ? notes.notes.length : null;
  const message: ToPage = { type: 'page', page, notes, state, pending: fromHelper?.pending ?? [], twoWay: helperState === 'connected', delivered: [...delivered] };
  try { port.postMessage(message); } catch { pages.delete(port); return; }
  info.shown = page;
  const focus = info.tabId === undefined ? undefined : focusing.get(info.tabId);
  if (focus?.page === page && info.tabId !== undefined) {
    focusing.delete(info.tabId);
    port.postMessage({ type: 'focus', note: focus.note } satisfies ToPage);
  }
}

ext.runtime.onConnect.addListener(port => {
  if (port.name !== 'page') return;
  connectHelper(); // installed since the browser started? pick it up without a restart
  pages.set(port, { url: '', page: '', shown: '', rev: 0, count: null, tabId: port.sender?.tab?.id });
  port.onDisconnect.addListener(() => pages.delete(port));
  port.onMessage.addListener(raw => {
    const m = raw as FromPage;
    const info = pages.get(port);
    if (!info) return;
    // The content script says which route it's on, since a single-page app moves without
    // reconnecting, but only the browser can say which site: a hello for another origin is ignored.
    if (m.type === 'hello') {
      if (!sameOrigin(m.url, port.sender?.url)) return;
      info.url = m.url; info.page = pageKey(m.url); void refresh(port);
    }
    // Messages and state changes count only for the page whose notes the content script was sent,
    // or, on a port that reconnected and hasn't been sent them yet, the page it said hello from.
    else if (m.type === 'send') { if (m.message.page === (info.shown || info.page)) helper?.postMessage({ type: 'send', message: m.message }); }
    else if (m.type === 'open') {
      if (!originPattern(m.url)) return; // web pages only
      void ext.tabs.create({ url: m.url, openerTabId: info.tabId }).then(tab => {
        if (tab.id !== undefined) focusing.set(tab.id, { page: pageKey(m.url), note: m.note });
      });
    }
    else if (!(info.shown || info.page)) return;
    else if (helper) helper.postMessage({ type: 'state', page: info.shown || info.page, state: m.state });
    else void saveLocalState(info.shown || info.page, m.state);
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
ext.runtime.onMessage.addListener((raw, sender, reply) => {
  // Only the extension's own pages ask here; content scripts talk over their port.
  if (sender.id !== ext.runtime.id || !sender.url?.startsWith(ext.runtime.getURL(''))) return false;
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
    void ext.tabs.get(m.tabId).then(tab => {
      activated.set(m.tabId, pageKey(tab.url ?? ''));
      return ext.scripting.executeScript({ target: { tabId: m.tabId }, files: ['content.js'] });
    }).then(() => {
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
void localReady.then(syncContentScripts).then(updateBadge);
