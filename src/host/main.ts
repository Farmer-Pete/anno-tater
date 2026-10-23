// The native messaging host. The browser starts it with the extension's id as an argument and
// talks to it over stdin/stdout. Anything written to stdout must be a framed message, so logs go to stderr.
import { mkdirSync, watch } from 'node:fs';
import { pageKey } from '../shared/notes.ts';
import type { FromHost, PageSummary, ToHost } from '../shared/protocol.ts';
import { decoder, encode } from './framing.ts';
import { appendInbox, dataDir, findPage, loadPages, pageRev, pending, readDelivered, readState, saveState } from './store.ts';

const send = (message: FromHost) => process.stdout.write(encode(message));
const log = (...args: unknown[]) => console.error('[anno-tater host]', ...args);

const pages = (): PageSummary[] => loadPages((file, problem) => log(`skipping ${file}: ${problem}`)).map(n => {
  const page = pageKey(n.url);
  return { page, url: n.url, title: n.title, rev: pageRev(page) };
});

function handle(raw: unknown): void {
  const message = raw as ToHost;
  try {
    if (message.type === 'get') {
      const { page } = message;
      send({ type: 'page', page, notes: findPage(page), state: readState(page), pending: pending(page) });
    } else if (message.type === 'send') {
      appendInbox(message.message);
      send({ type: 'sent', id: message.message.id });
    } else if (message.type === 'state') {
      saveState(message.page, message.state);
    }
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
}

// Coalesce bursts of file events (an atomic write is a create plus a rename).
function debounced(fn: () => void, ms = 150): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

// Any change in the data folder (notes, shared state, an inbox, or another browser's helper
// writing) moves the affected page's rev; the extension re-fetches open pages whose rev moved.
let lastDelivered = readDelivered();
const onChange = debounced(() => {
  send({ type: 'pages', pages: pages() });
  const now = readDelivered();
  const fresh = [...now].filter(id => !lastDelivered.has(id));
  lastDelivered = now;
  if (fresh.length) send({ type: 'delivered', ids: fresh });
});
mkdirSync(dataDir(), { recursive: true });
watch(dataDir(), { recursive: true }, (_event, file) => { if (!String(file).startsWith('bin')) onChange(); });

process.stdin.on('data', decoder(handle));
process.stdin.on('end', () => process.exit(0));
send({ type: 'hello', pages: pages(), delivered: [...lastDelivered].slice(-500) });
log(`started for ${process.argv.slice(2).join(' ')}; data in ${dataDir()}`);
