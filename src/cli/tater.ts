// tater: the agent's side of Anno Tater.
import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { encodeFragment, parseNotes, type Note, type NotesFile, type Outgoing } from '../shared/notes.ts';
import { CHROME_ID } from '../shared/protocol.ts';
import { BROWSERS, browserName, defaultBrowser, detected, geckoBase, isBrowser, openIn, type Browser } from '../host/browsers.ts';
import { cliPath, install, installed, uninstall } from '../host/install.ts';
import { channelExists, channels, dataDir, findPage, inboxDir, loadPages, markDelivered, newChannel, readDelivered, readInbox, savePage } from '../host/store.ts';

const USAGE = `tater: let an agent mark up web pages with Anno Tater

  tater channel                             Create a channel: your inbox for replies (a random UUID)
  tater open <notes.json> [--browser B]     Store notes and open the page in your default browser (no helper needed)
  tater push <notes.json>                   Store or update notes; pages open with the helper redraw live
  tater watch --channel ID [--once]         Print new messages for a channel, one JSON line each
  tater reply <message-id> <text|->         Answer a message in its thread ("-" reads the text from stdin)
  tater ack <message-id>...                 Mark messages handled without answering
  tater check <notes.json>                  Validate a notes file
  tater status                              Pages, helper install state, and waiting messages
  tater install [--browser B]               Register the helper with your browsers (needed for replies)
  tater uninstall [--browser B]

  open and push use the notes file's "channel", or --channel ID, or create a new channel and write
  it into the file, so later pushes of that file reuse it. B is chrome, firefox, or zen (install:
  every browser found; open: the default browser). Data lives in ${dataDir()}.`;

const fail = (message: string): never => { console.error(message); process.exit(1); };
const readNotes = (file: string) => {
  try { return parseNotes(readFileSync(file, 'utf8')); } catch (e) { return fail(`${file}: ${(e as Error).message}`); }
};
const browsers = (b: string | undefined, all: Browser[]): Browser[] =>
  b === undefined ? all : isBrowser(b) ? [b] : fail(`unknown browser: ${b} (use ${BROWSERS.join(', ')})`);
const targetBrowser = (b: string | undefined): Browser =>
  browsers(b, [])[0] ?? defaultBrowser() ?? fail(`your default browser isn't one Anno Tater supports; pass --browser ${BROWSERS.join('|')}`);

// ---------- messages ----------
const ackedIds = () => new Set(loadPages().flatMap(p => p.acked ?? []));
const allMessages = () => channels().flatMap(readInbox);
const findMessage = (id: string) => allMessages().find(m => m.id === id) ?? fail(`no message with id ${id}`);

// The channel's notes for the message's page. A question asked on a page this channel hasn't
// annotated yet starts a new notes file there.
function pageFor(m: Outgoing): NotesFile & { channel: string } {
  return findPage(m.channel, m.match) ?? { channel: m.channel, match: m.match, url: m.page || undefined, notes: [] };
}

function saveWithAck(page: NotesFile & { channel: string }, ids: string[]): void {
  page.acked = [...new Set([...(page.acked ?? []), ...ids])];
  savePage(page);
}

async function readText(arg: string | undefined): Promise<string> {
  if (arg !== '-') return arg ?? fail('reply needs the text, or "-" to read it from stdin');
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text.trim();
}

function reply(m: Outgoing, text: string): string {
  const page = pageFor(m);
  if (m.kind === 'ask') {
    // A question about a selection becomes a new note anchored where the person selected.
    const note: Note = {
      id: `q-${m.id}`, kind: 'info', quote: m.quote ?? fail('the question has no quote to anchor on'),
      prefix: m.prefix, suffix: m.suffix, title: `Your question: ${(m.text ?? '').slice(0, 60)}`,
      thread: [{ from: 'you', text: m.text ?? '' }, { from: 'claude', text }],
    };
    page.notes.push(note);
  } else {
    const note = page.notes.find(n => n.id === m.noteId) ?? fail(`note ${m.noteId} is not in the notes file any more`);
    note.thread = [...(note.thread ?? []), ...(m.text ? [{ from: 'you' as const, text: m.text }] : []), { from: 'claude' as const, text }];
  }
  saveWithAck(page, [m.id]);
  return m.kind === 'ask' ? `added note q-${m.id}` : `answered on ${m.noteId}`;
}

// Prints every message not yet acked, then follows the inboxes. Printing marks a message delivered,
// which the page shows as "Claude has it".
function watchInbox(channel: string, once: boolean): void {
  if (!channelExists(channel)) fail(`no channel ${channel}`);
  const printed = new Set<string>();
  const flush = () => {
    const acked = ackedIds();
    const fresh = readInbox(channel).filter(m => !acked.has(m.id) && !printed.has(m.id));
    for (const m of fresh) {
      printed.add(m.id);
      const { id, kind, noteId, quote, prefix, suffix, text, match } = m;
      console.log(JSON.stringify({ id, kind, noteId, match, quote, prefix, suffix, text }));
    }
    markDelivered(fresh.map(m => m.id));
  };
  flush();
  if (once) return;
  mkdirSync(inboxDir(), { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  watch(inboxDir(), () => { clearTimeout(timer); timer = setTimeout(flush, 100); });
  setInterval(flush, 5000); // a safety net in case a file event is missed
}

// ---------- opening pages ----------
// With the helper, the browser fetches the notes itself, so tater just opens the page. Without
// it, the notes ride in the fragment of the extension's intake page.
async function openPage(notes: NotesFile, browser: Browser): Promise<string> {
  const target = notes.url ?? fail('open needs a "url" in the notes file');
  if (installed(browser)) {
    openIn(browser, target);
    return `opened ${target} in ${browserName(browser)}; the helper delivers the notes`;
  }
  const base = browser === 'chrome'
    ? `chrome-extension://${CHROME_ID}`
    : geckoBase(browser) ?? fail(`can't find Anno Tater in ${browserName(browser)}; install the extension there first`);
  openIn(browser, `${base}/open.html#${await encodeFragment(notes, target)}`);
  return `opened ${target} in ${browserName(browser)} through the extension (one-way: run tater install for replies)`;
}

// Validates and saves a notes file in its channel, creating a channel when it has none and
// writing it back into the file so later pushes reuse it. Says where replies will arrive.
function store(file: string, flag: string | undefined): NotesFile & { channel: string } {
  const notes = readNotes(file);
  const fresh = !flag && !notes.channel;
  const channel = flag ?? notes.channel ?? newChannel();
  if (!channelExists(channel)) fail(`no channel ${channel}; create one with tater channel`);
  if (notes.channel !== channel) writeFileSync(file, `${JSON.stringify({ ...notes, channel }, null, 2)}\n`);
  const before = findPage(channel, notes.match);
  // Threads and handled messages live in the stored copy; keep them when the agent's copy lacks them.
  const merged = { ...notes, channel, acked: [...new Set([...(before?.acked ?? []), ...(notes.acked ?? [])])] };
  for (const note of merged.notes) note.thread ??= before?.notes.find(n => n.id === note.id)?.thread;
  console.log(`saved ${savePage(merged)}`);
  console.log(`${fresh ? 'new channel' : 'channel'} ${channel}; replies: tater watch --channel ${channel}`);
  return merged;
}

// ---------- main ----------
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { channel: { type: 'string' }, browser: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
});
const [command, ...args] = positionals;

switch (values.help ? 'help' : command) {
  case 'channel':
    console.log(newChannel());
    break;
  case 'push':
    store(args[0] ?? fail('push needs a notes file'), values.channel);
    break;
  case 'open': {
    const notes = store(args[0] ?? fail('open needs a notes file'), values.channel);
    console.log(await openPage(notes, targetBrowser(values.browser)));
    break;
  }
  case 'check': {
    const notes = readNotes(args[0] ?? fail('check needs a notes file'));
    console.log(`ok: ${notes.notes.length} notes for ${notes.match}`);
    break;
  }
  case 'watch':
    watchInbox(values.channel ?? fail('watch needs --channel ID (tater open and push print it)'), values.once ?? false);
    break;
  case 'reply': {
    const m = findMessage(args[0] ?? fail('reply needs a message id'));
    console.log(reply(m, await readText(args[1])));
    break;
  }
  case 'ack': {
    if (!args.length) fail('ack needs message ids');
    for (const id of args) saveWithAck(pageFor(findMessage(id)), [id]);
    console.log(`acked ${args.length}`);
    break;
  }
  case 'status': {
    const acked = ackedIds(), delivered = readDelivered();
    console.log(`data: ${dataDir()}`);
    console.log(`default browser: ${defaultBrowser() ?? 'not supported'}`);
    console.log(`helper: ${BROWSERS.map(b => `${b} ${installed(b) ? 'installed' : 'not installed'}`).join(', ')}`);
    const pages = loadPages((f, why) => console.log(`invalid ${f}: ${why}`));
    for (const c of channels()) {
      const waiting = readInbox(c).filter(m => !acked.has(m.id));
      console.log(`channel ${c}${waiting.length ? `: ${waiting.length} waiting (${waiting.filter(m => !delivered.has(m.id)).length} not yet picked up)` : ''}`);
      for (const p of pages.filter(q => q.channel === c)) console.log(`  ${p.match} (${p.notes.length} notes)`);
    }
    break;
  }
  case 'install':
    for (const f of install(browsers(values.browser, detected()))) console.log(`wrote ${f}`);
    console.log(`agents can run tater as ${cliPath()}`);
    console.log('Anno Tater picks the helper up the next time you open its popup or load a page with notes.');
    break;
  case 'uninstall':
    for (const f of uninstall(browsers(values.browser, [...BROWSERS]))) console.log(`removed ${f}`);
    break;
  default:
    console.log(USAGE);
    if (command && command !== 'help') process.exit(1);
}
