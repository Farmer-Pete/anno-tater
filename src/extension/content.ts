// Runs at document_start on sites the person allowed. Asks the background for this page's notes
// and hands them to the engine. Does nothing visible on a page without notes.
import { createEngine, type Store } from '../engine/engine.ts';
import { ext, type FromPage, type ToPage } from './compat.ts';
import { mergeLayers, type Origin } from '../shared/layers.ts';
import type { NotesFile, Outgoing } from '../shared/notes.ts';

const FLAG = '__annoTaterLoaded';
const g = globalThis as Record<string, unknown>;

if (!g[FLAG]) {
  g[FLAG] = true;

  // UI state lives in extension storage, not the site's localStorage. Reads come from a cache
  // loaded at startup; writes go to both.
  const cache: Record<string, unknown> = {};
  const store: Store = {
    get: <T>(key: string, fallback: T) => (key in cache ? (cache[key] as T) : fallback),
    set: (key, value) => { cache[key] = value; void ext.storage.local.set({ [`ui:${key}`]: value }); },
  };

  let notes: NotesFile | null = null;  // the merged layers the engine draws
  let layers: NotesFile[] = [];          // one per channel, newest first
  let origin = new Map<string, Origin>(); // merged note id -> the channel and file that wrote it
  let port: chrome.runtime.Port | null = null;
  const post = (m: FromPage) => port?.postMessage(m);

  // The engine works with merged note ids. The helper gets the message addressed to the channel
  // that wrote the note; a question about plain text goes to the newest layer's channel.
  const engine = createEngine(store, draft => {
    const from = draft.noteId ? origin.get(draft.noteId) : undefined;
    const newest = layers[0];
    const message: Outgoing = {
      ...draft,
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      page: location.href,
      channel: from?.channel ?? newest?.channel ?? '',
      match: from?.match ?? newest?.match ?? location.href,
    };
    post({ type: 'send', message: { ...message, noteId: from?.id ?? null } });
    return message;
  });

  let loaded = false;
  const startWhenReady = () => {
    if (!notes || !loaded) return;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => engine.start(), { once: true });
    else engine.start();
  };

  function onMessage(raw: unknown): void {
    const m = raw as ToPage;
    if (m.type === 'notes') {
      layers = m.layers;
      const merged = layers.length ? mergeLayers(layers) : null;
      notes = merged?.merged ?? null;
      origin = merged?.origin ?? new Map();
      engine.load(notes, m.twoWay);
      engine.setDelivered(m.delivered);
      startWhenReady();
    } else if (m.type === 'delivered') engine.setDelivered(m.ids);
    else if (m.type === 'twoWay') engine.setTwoWay(m.on);
    else engine.setHidden(!engine.isHidden());
  }

  // The background can go to sleep (Chrome) and drop the port; reconnect and ask again.
  function connect(): void {
    port = ext.runtime.connect({ name: 'page' });
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 1000); });
    post({ type: 'hello', url: location.href });
  }

  void ext.storage.local.get(null).then(all => {
    for (const [k, v] of Object.entries(all)) if (k.startsWith('ui:')) cache[k.slice(3)] = v;
    loaded = true;
    startWhenReady();
  });
  connect();
}
