// Runs at document_start on sites the person allowed. Asks the background for this page's notes
// and hands them to the engine. Does nothing visible on a page without notes.
import { createEngine, type Store } from '../engine/engine.ts';
import { ext, type FromPage, type ToPage } from './compat.ts';
import { pageKey, type NotesFile, type Outgoing } from '../shared/notes.ts';

const FLAG = '__annoTaterLoaded';
const g = globalThis as Record<string, unknown>;

if (!g[FLAG]) {
  g[FLAG] = true;

  // View settings live in extension storage, not the site's localStorage. Reads come from a
  // cache loaded at startup; writes go to both.
  const cache: Record<string, unknown> = {};
  const store: Store = {
    get: <T>(key: string, fallback: T) => (key in cache ? (cache[key] as T) : fallback),
    set: (key, value) => { cache[key] = value; void ext.storage.local.set({ [`ui:${key}`]: value }); },
  };

  let notes: NotesFile | null = null;
  let port: chrome.runtime.Port | null = null;
  const post = (m: FromPage) => port?.postMessage(m);

  // Messages go to the page's inbox; shared state (ticked steps, read replies) to the helper.
  const engine = createEngine(store, draft => {
    const message: Outgoing = {
      ...draft,
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      page: pageKey(location.href),
      url: location.href,
    };
    post({ type: 'send', message });
    return message;
  }, state => post({ type: 'state', state }), (url, note) => post({ type: 'open', url, note }));

  let loaded = false;
  const startWhenReady = () => {
    if (!notes || !loaded) return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => engine.start(), { once: true });
    else engine.start();
  };

  // The page key the background is looking up for us. Single-page apps change it without a reload.
  let current = '';
  const hello = () => { current = pageKey(location.href); post({ type: 'hello', url: location.href }); };

  function onMessage(raw: unknown): void {
    const m = raw as ToPage;
    if (m.type === 'page') {
      if (m.page !== current) return; // an answer for the route we just left
      notes = m.notes;
      engine.load(notes, { twoWay: m.twoWay, state: m.state, pending: m.pending });
      engine.setDelivered(m.delivered);
      startWhenReady();
    } else if (m.type === 'delivered') engine.setDelivered(m.ids);
    else if (m.type === 'twoWay') engine.setTwoWay(m.on);
    else if (m.type === 'focus') engine.focus(m.note);
    else engine.setHidden(!engine.isHidden());
  }

  // The background can go to sleep (Chrome) and drop the port; reconnect and ask again.
  function connect(): void {
    port = ext.runtime.connect({ name: 'page' });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
    hello();
  }

  // pushState fires no event a content script can see, so check the address twice a second too.
  const follow = () => { if (pageKey(location.href) !== current) hello(); };
  addEventListener('hashchange', follow);
  addEventListener('popstate', follow);
  setInterval(follow, 500);

  void ext.storage.local.get(null).then(all => {
    for (const [k, v] of Object.entries(all)) if (k.startsWith('ui:')) cache[k.slice(3)] = v;
    loaded = true;
    startWhenReady();
  });
  connect();
}
