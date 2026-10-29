// tater: the agent's side of Anno Tater.
import { mkdirSync, readFileSync, watch } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { encodeFragment, glossaryProblems, pageKey, parseNotes, type Note, type NotesFile, type Outgoing, type Term } from '../shared/notes.ts';
import { CHROME_ID } from '../shared/protocol.ts';
import { BROWSERS, browserName, defaultBrowser, detected, geckoBase, isBrowser, openIn, type Browser } from '../host/browsers.ts';
import { cliPath, install, installed, uninstall } from '../host/install.ts';
import { dataDir, findPage, loadPages, markDelivered, pageDir, pagesDir, pending, readAllInboxes, readDelivered, savePage } from '../host/store.ts';

const USAGE = `tater: let an agent mark up web pages with Anno Tater

  tater open <notes.json> [--browser B]     Store notes and open the page in your default browser (no helper needed)
  tater push <notes.json>                   Store or update notes; pages open with the helper redraw live
                                            (--force: replace notes another agent session wrote)
  tater watch --page URL... [--once]        Print new messages from pages, one JSON line each (repeat --page; --all: every page)
              [--skip done,undone]          Ack ticked-step events without printing them
  tater reply <message-id> <text|->         Answer a message in its thread ("-" reads the text from stdin)
  tater reply --note ID <text|->            Answer every message waiting on a note (--page URL if the id repeats)
  tater ack <message-id>...                 Mark messages handled without answering
  tater check <notes.json>                  Validate a notes file
  tater status                              Pages, helper install state, and waiting messages
  tater install [--browser B]               Register the helper with your browsers (needed for replies)
  tater uninstall [--browser B]

  A page's URL is its key: one notes file and one conversation per page, in every browser.
  B is chrome, zen, or firefox-dev (install: every browser found; open: the default browser).
  Data lives in ${dataDir()}.`;

const fail = (message: string): never => { console.error(message); process.exit(1); };
const readNotes = (file: string) => {
  try { return withSharedGlossary(parseNotes(readFileSync(file, 'utf8')), file); } catch (e) { return fail(`${file}: ${(e as Error).message}`); }
};

// Merges the terms from glossaryFiles (each a list of terms, or an object with a glossary list,
// such as another notes file) into the page's glossary. A page's own term wins over a shared one.
function withSharedGlossary(notes: NotesFile, file: string): NotesFile {
  const shared = new Map<string, Term>();
  for (const g of notes.glossaryFiles ?? []) {
    let v: unknown;
    try { v = JSON.parse(readFileSync(resolve(dirname(file), g), 'utf8')); } catch (e) { throw new Error(`glossary file ${g}: ${(e as Error).message}`, { cause: e }); }
    const list: unknown = Array.isArray(v) ? v : (v as { glossary?: unknown } | null)?.glossary;
    const problems = glossaryProblems(list, g);
    if (problems.length) throw new Error(problems.join('\n'));
    for (const t of list as Term[]) shared.set(t.term, t);
  }
  if (!shared.size) return notes;
  for (const t of notes.glossary ?? []) shared.delete(t.term);
  return { ...notes, glossary: [...shared.values(), ...(notes.glossary ?? [])] };
}
const browsers = (b: string | undefined, all: Browser[]): Browser[] =>
  b === undefined ? all : isBrowser(b) ? [b] : fail(`unknown browser: ${b} (use ${BROWSERS.join(', ')})`);
const targetBrowser = (b: string | undefined): Browser =>
  browsers(b, [])[0] ?? defaultBrowser() ?? fail(`your default browser isn't one Anno Tater supports; pass --browser ${BROWSERS.join('|')}`);

// ---------- messages ----------
const findMessage = (id: string) => readAllInboxes().find(m => m.id === id) ?? fail(`no message with id ${id}`);

// The agent session running tater, when the agent says (Claude Code sets this for its shell).
const session = process.env.CLAUDE_CODE_SESSION_ID || undefined;
const short = (id: string) => id.slice(0, 8);

// The page's notes. A question asked on a page without notes starts a notes file there.
const pageFor = (m: Outgoing): NotesFile => findPage(m.page) ?? { url: m.url, notes: [], session };

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

// The messages still waiting on a note, oldest first. A note id can repeat across pages; --page picks one.
function waitingOn(noteId: string, page: string | null): Outgoing[] {
  const all = page ? pending(page) : loadPages().flatMap(p => pending(pageKey(p.url)));
  const ms = all.filter(m => m.noteId === noteId);
  const pages = new Set(ms.map(m => m.page));
  if (pages.size > 1) fail(`note ${noteId} has messages waiting on ${pages.size} pages; add --page URL`);
  return ms.length ? ms : fail(`no message is waiting on note ${noteId}`);
}

// Answers one message, or several on the same note: their texts join the thread in order, then the answer.
function reply(ms: Outgoing[], text: string): string {
  const [m] = ms;
  if (!m) return fail('nothing to answer');
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
    const yours = ms.flatMap(x => (x.text ? [{ from: 'you' as const, text: x.text }] : []));
    note.thread = [...(note.thread ?? []), ...yours, { from: 'claude' as const, text }];
  }
  saveWithAck(page, ms.map(x => x.id));
  return m.kind === 'ask' ? `added note q-${m.id}` : `answered on ${m.noteId}${ms.length > 1 ? ` (${ms.length} messages)` : ''}`;
}

// Prints every message not yet answered or acked, then follows the inbox. Printing marks a
// message delivered, which the page shows as "Claude has it".
// Skipped kinds (only step ticks) are acked instead, so the page doesn't show them as waiting.
function watchInbox(pages: string[] | null, once: boolean, skip: Set<string>): void {
  const printed = new Set<string>();
  const waiting = () => (pages ? pages.flatMap(pending) : loadPages().flatMap(p => pending(pageKey(p.url))).concat(orphans()));
  const flush = () => {
    const all = waiting().filter(m => !printed.has(m.id));
    const skipped = all.filter(m => skip.has(m.kind));
    for (const m of skipped) saveWithAck(pageFor(m), [m.id]);
    const fresh = all.filter(m => !skip.has(m.kind));
    for (const m of fresh) {
      printed.add(m.id);
      const { id, kind, noteId, quote, prefix, suffix, text, url } = m;
      console.log(JSON.stringify({ id, kind, noteId, url, quote, prefix, suffix, text }));
    }
    markDelivered(fresh.map(m => m.id));
  };
  flush();
  if (once) return;
  // Named pages: each page's own folder. Every page: the whole tree, which also sees notes and
  // state writes, so only inbox changes count.
  let timer: NodeJS.Timeout | undefined;
  for (const dir of pages ? pages.map(pageDir) : [pagesDir()]) {
    mkdirSync(dir, { recursive: true });
    watch(dir, { recursive: !pages }, (_event, file) => {
      if (String(file).endsWith('inbox.jsonl')) { clearTimeout(timer); timer = setTimeout(flush, 100); }
    });
  }
  setInterval(flush, 5000); // a safety net in case a file event is missed
}

// Questions from pages that have no notes file yet (asked through "Ask Claude about this page").
function orphans(): Outgoing[] {
  const withNotes = new Set(loadPages().map(p => pageKey(p.url)));
  return readAllInboxes().filter(m => !withNotes.has(m.page));
}

// ---------- opening pages ----------
// With the helper, the browser fetches the notes itself, so tater just opens the page. Without
// it, the notes ride in the fragment of the extension's intake page.
async function openPage(notes: NotesFile, browser: Browser): Promise<string> {
  if (installed(browser)) {
    openIn(browser, notes.url);
    return `opened ${notes.url} in ${browserName(browser)}; the helper delivers the notes`;
  }
  const base = browser === 'chrome'
    ? `chrome-extension://${CHROME_ID}`
    : geckoBase(browser) ?? fail(`can't find Anno Tater in ${browserName(browser)}; install the extension there first`);
  openIn(browser, `${base}/open.html#${await encodeFragment(notes)}`);
  return `opened ${notes.url} in ${browserName(browser)} through the extension (one-way: run tater install for replies)`;
}

// Validates and saves a notes file for its page. Threads and handled messages live in the stored
// copy, so they're kept when the agent's copy lacks them. Notes another session wrote are kept
// unless --force says to replace them. Says where replies will arrive.
function store(file: string, force: boolean): NotesFile {
  const notes = readNotes(file);
  const before = findPage(pageKey(notes.url));
  if (before?.session && session && before.session !== session && !force) {
    fail(`another agent session (${short(before.session)}) wrote the notes for ${notes.url}; pass --force to replace them`);
  }
  const merged = { ...notes, session: session ?? before?.session, acked: [...new Set([...(before?.acked ?? []), ...(notes.acked ?? [])])] };
  for (const note of merged.notes) note.thread ??= before?.notes.find(n => n.id === note.id)?.thread;
  console.log(`saved ${savePage(merged)}`);
  console.log(`replies: tater watch --page ${notes.url}`);
  return merged;
}

// ---------- main ----------
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { page: { type: 'string', multiple: true }, skip: { type: 'string' }, force: { type: 'boolean' }, note: { type: 'string' }, all: { type: 'boolean' }, browser: { type: 'string' }, once: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
});
const [command, ...args] = positionals;
const pages = [...new Set((values.page ?? []).map(pageKey))];

switch (values.help ? 'help' : command) {
  case 'push':
    store(args[0] ?? fail('push needs a notes file'), values.force ?? false);
    break;
  case 'open':
    console.log(await openPage(store(args[0] ?? fail('open needs a notes file'), values.force ?? false), targetBrowser(values.browser)));
    break;
  case 'check': {
    const notes = readNotes(args[0] ?? fail('check needs a notes file'));
    console.log(`ok: ${notes.notes.length} notes${notes.glossary?.length ? ` and ${notes.glossary.length} terms` : ''} for ${notes.url}`);
    break;
  }
  case 'watch':
    if (!pages.length && !values.all) fail('watch needs --page URL (open and push print it; repeat it for several pages), or --all');
    const skip = new Set(values.skip?.split(',').map(k => k.trim()).filter(Boolean));
    for (const k of skip) if (k !== 'done' && k !== 'undone') fail(`--skip takes done and undone only (got ${k}): every other message needs an answer`);
    watchInbox(values.all ? null : pages, values.once ?? false, skip);
    break;
  case 'reply': {
    if (values.note) {
      if (pages.length > 1) fail('reply --note takes one --page');
      const ms = waitingOn(values.note, pages[0] ?? null);
      console.log(reply(ms, await readText(args[0])));
    } else {
      const m = findMessage(args[0] ?? fail('reply needs a message id, or --note ID'));
      console.log(reply([m], await readText(args[1])));
    }
    break;
  }
  case 'ack': {
    if (!args.length) fail('ack needs message ids');
    for (const id of args) saveWithAck(pageFor(findMessage(id)), [id]);
    console.log(`acked ${args.length}`);
    break;
  }
  case 'status': {
    const delivered = readDelivered();
    console.log(`data: ${dataDir()}`);
    console.log(`default browser: ${defaultBrowser() ?? 'not supported'}`);
    console.log(`helper: ${BROWSERS.map(b => `${b} ${installed(b) ? 'installed' : 'not installed'}`).join(', ')}`);
    for (const p of loadPages((f, why) => console.log(`invalid ${f}: ${why}`))) {
      const waiting = pending(pageKey(p.url));
      const unseen = waiting.filter(m => !delivered.has(m.id)).length;
      const owner = p.session ? `, session ${short(p.session)}${p.session === session ? ' (this one)' : ''}` : '';
      console.log(`page: ${p.url} (${p.notes.length} notes${owner}${waiting.length ? `, ${waiting.length} waiting, ${unseen} not yet picked up` : ''})`);
    }
    if (orphans().length) console.log(`questions from pages without notes: ${orphans().length} (tater watch --all)`);
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
