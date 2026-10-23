// The native messaging host. The browser starts it with the extension's id as an argument and
// talks to it over stdin/stdout. Anything written to stdout must be a framed message, so logs go to stderr.
import { mkdirSync, statSync, watch } from 'node:fs';
import { DEFAULT_OWNER, type NotesFile } from '../shared/notes.ts';
import type { FromHost, PageSummary, ToHost } from '../shared/protocol.ts';
import { decoder, encode } from './framing.ts';
import { appendInbox, dataDir, DELIVERED, findPage, loadPages, pageFile, pagesDir, readDelivered } from './store.ts';

const send = (message: FromHost) => process.stdout.write(encode(message));
const log = (...args: unknown[]) => console.error('[anno-tater host]', ...args);

const rev = (match: string) => {
  try { return statSync(pageFile(match)).mtimeMs; } catch { return 0; }
};
const summary = (p: NotesFile): PageSummary => ({ match: p.match, url: p.url, title: p.title, owner: p.owner, rev: rev(p.match) });
const pages = () => loadPages((file, problem) => log(`skipping ${file}: ${problem}`)).map(summary);

function handle(raw: unknown): void {
  const message = raw as ToHost;
  try {
    if (message.type === 'get') {
      send({ type: 'notes', match: message.match, notes: findPage(message.match) });
    } else if (message.type === 'send') {
      appendInbox({ ...message.message, owner: message.message.owner || DEFAULT_OWNER });
      send({ type: 'sent', id: message.message.id });
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

mkdirSync(pagesDir(), { recursive: true });
watch(pagesDir(), debounced(() => send({ type: 'pages', pages: pages() })));
let lastDelivered = readDelivered();
watch(dataDir(), (_event, file) => { if (file === DELIVERED) onDelivered(); });
const onDelivered = debounced(() => {
  const now = readDelivered();
  const fresh = [...now].filter(id => !lastDelivered.has(id));
  lastDelivered = now;
  if (fresh.length) send({ type: 'delivered', ids: fresh });
});

process.stdin.on('data', decoder(handle));
process.stdin.on('end', () => process.exit(0));
send({ type: 'hello', pages: pages(), delivered: [...lastDelivered].slice(-500) });
log(`started for ${process.argv.slice(2).join(' ')}; data in ${dataDir()}`);
