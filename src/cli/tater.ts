// tater: the agent's side of Anno Tater.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, watch } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_OWNER, encodeFragment, parseNotes, type Note, type NotesFile, type Outgoing } from '../shared/notes.ts';
import { CHROME_ID } from '../shared/protocol.ts';
import { BROWSERS, cliPath, detected, install, installed, uninstall, type Browser } from '../host/install.ts';
import { dataDir, findPage, inboxDir, loadPages, markDelivered, readDelivered, readInbox, savePage } from '../host/store.ts';

const USAGE = `tater: let an agent mark up web pages with Anno Tater

  tater push <notes.json> [--owner NAME]    Store notes; pages open in a browser with the helper update live
  tater open <notes.json> [--browser B]     Store notes and open the page (no helper needed)
  tater watch [--owner NAME] [--once]       Print new messages from the page, one JSON line each
  tater reply <message-id> <text|->         Answer a message in its thread ("-" reads the text from stdin)
  tater ack <message-id>...                 Mark messages handled without answering
  tater check <notes.json>                  Validate a notes file
  tater status                              Pages, helper install state, and waiting messages
  tater install [--browser B]               Register the helper with your browsers (needed for replies)
  tater uninstall [--browser B]
  tater config firefox-base <moz-extension://...>   The extension's address in Firefox or Zen (its popup shows the command)

  B is chrome, firefox, or zen (install: every browser found; open: chrome). Data lives in ${dataDir()}.`;

const fail = (message: string): never => { console.error(message); process.exit(1); };
const readNotes = (file: string) => {
  try { return parseNotes(readFileSync(file, 'utf8')); } catch (e) { return fail(`${file}: ${(e as Error).message}`); }
};
const isBrowser = (b: string): b is Browser => (BROWSERS as readonly string[]).includes(b);
const browsers = (b: string | undefined, all: Browser[]): Browser[] =>
  b === undefined ? all : isBrowser(b) ? [b] : fail(`unknown browser: ${b} (use ${BROWSERS.join(', ')})`);
const APPS: Record<Browser, string> = { chrome: 'Google Chrome', firefox: 'Firefox', zen: 'Zen' };
const BINARIES: Record<Browser, string> = { chrome: 'google-chrome', firefox: 'firefox', zen: 'zen' };

// ---------- config ----------
const configFile = () => join(dataDir(), 'config.json');
const readConfig = (): Record<string, string> => { try { return JSON.parse(readFileSync(configFile(), 'utf8')); } catch { return {}; } };
function writeConfig(key: string, value: string): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configFile(), JSON.stringify({ ...readConfig(), [key]: value }, null, 2));
}

// ---------- messages ----------
const ackedIds = () => new Set(loadPages().flatMap(p => p.acked ?? []));
const owners = () => (existsSync(inboxDir()) ? readdirSync(inboxDir()).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)) : []);
const allMessages = () => owners().flatMap(readInbox);
const findMessage = (id: string) => allMessages().find(m => m.id === id) ?? fail(`no message with id ${id}`);

function pageFor(m: Outgoing): NotesFile {
  return findPage(m.match) ?? fail(`the notes file for ${m.match} is gone`);
}

function saveWithAck(page: NotesFile, ids: string[]): void {
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
function watchInbox(owner: string | undefined, once: boolean): void {
  const printed = new Set<string>();
  const flush = () => {
    const acked = ackedIds();
    const fresh = (owner ? readInbox(owner) : allMessages()).filter(m => !acked.has(m.id) && !printed.has(m.id));
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
function openUrl(url: string, browser: Browser): void {
  if (platform() === 'darwin') execFileSync('open', ['-a', readConfig()[`${browser}-app`] ?? APPS[browser], url]);
  else execFileSync(BINARIES[browser], [url]);
}

async function openPage(notes: NotesFile, browser: Browser): Promise<string> {
  const target = notes.url ?? fail('open needs a "url" in the notes file');
  if (installed(browser)) {
    openUrl(target, browser);
    return `opened ${target}; the helper delivers the notes`;
  }
  const base = browser === 'chrome'
    ? `chrome-extension://${CHROME_ID}`
    : readConfig()['firefox-base'] ?? fail(`${APPS[browser]} needs its extension address once: open the Anno Tater popup there and run the command it shows`);
  const url = `${base}/open.html#${await encodeFragment(notes, target)}`;
  openUrl(url, browser);
  return `opened ${target} through the extension (one-way: install the helper for replies)`;
}

// ---------- main ----------
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { owner: { type: 'string' }, browser: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
});
const [command, ...args] = positionals;

switch (values.help ? 'help' : command) {
  case 'push': {
    const notes = readNotes(args[0] ?? fail('push needs a notes file'));
    if (values.owner) notes.owner = values.owner;
    notes.owner ??= DEFAULT_OWNER;
    console.log(`saved ${savePage(notes)}`);
    break;
  }
  case 'open': {
    const notes = readNotes(args[0] ?? fail('open needs a notes file'));
    if (values.owner) notes.owner = values.owner;
    notes.owner ??= DEFAULT_OWNER;
    savePage(notes);
    console.log(await openPage(notes, browsers(values.browser, ['chrome'])[0] ?? 'chrome'));
    break;
  }
  case 'check': {
    const notes = readNotes(args[0] ?? fail('check needs a notes file'));
    console.log(`ok: ${notes.notes.length} notes for ${notes.match}`);
    break;
  }
  case 'watch':
    watchInbox(values.owner, values.once ?? false);
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
    console.log(`helper: ${BROWSERS.map(b => `${b} ${installed(b) ? 'installed' : 'not installed'}`).join(', ')}`);
    for (const p of loadPages((f, why) => console.log(`  invalid ${f}: ${why}`))) console.log(`page: ${p.match} (${p.notes.length} notes, owner ${p.owner ?? DEFAULT_OWNER})`);
    for (const o of owners()) {
      const waiting = readInbox(o).filter(m => !acked.has(m.id));
      if (waiting.length) console.log(`inbox ${o}: ${waiting.length} waiting (${waiting.filter(m => !delivered.has(m.id)).length} not yet picked up)`);
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
  case 'config': {
    const [key = '', value = ''] = args;
    if (key !== 'firefox-base' || !value.startsWith('moz-extension://')) fail('usage: tater config firefox-base moz-extension://<id>  (Firefox and Zen share it)');
    writeConfig(key, value.replace(/\/+$/, ''));
    console.log('saved');
    break;
  }
  default:
    console.log(USAGE);
    if (command && command !== 'help') process.exit(1);
}
