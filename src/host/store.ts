// The data folder that the CLI and the helper share. Everything is keyed by page: one folder per
// page URL, whatever the browser.
//
//   data/<page>/page.json     the page's notes (written by the agent through tater)
//   data/<page>/state.json    ticked steps and read replies, shared by every browser
//   data/<page>/inbox.jsonl   the person's messages from the page, one JSON object per line
//   delivered.jsonl           ids of messages an agent has picked up (drives "Claude has it"), one
//                             per line. Append-only, so several writers can't overwrite each other.
//   layout                    the version of this layout the folder is in (see migrate)
//
// It holds page quotes and conversations, so only the person can read it: folders are created
// 0700 and files 0600.
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { messageProblems, originPattern, pageKey, parseNotes, type NotesFile, type Outgoing } from '../shared/notes.ts';
import { mergeState, stateProblems, type PageState } from '../shared/protocol.ts';
import { MAX_NOTES, MAX_PENDING, MAX_STATE } from './framing.ts';

export const dataDir = () =>
  process.env.ANNO_TATER_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'anno-tater');
export const pagesDir = () => join(dataDir(), 'data');
const deliveredFile = () => join(dataDir(), 'delivered.jsonl');
const layoutFile = () => join(dataDir(), 'layout');
const PRIVATE_DIR = 0o700, PRIVATE_FILE = 0o600;
const makeDir = (dir: string) => mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });

// A readable file name for a page key. The 16 hex digits of its SHA-256 keep two long addresses
// on one site from sharing a folder.
const fileName = (page: string) =>
  `${page.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x'}-${createHash('sha256').update(page).digest('hex').slice(0, 16)}`;
export const pageDir = (page: string) => join(pagesDir(), fileName(page));
const notesFile = (page: string) => join(pageDir(page), 'page.json');
const stateFile = (page: string) => join(pageDir(page), 'state.json');
const inboxFile = (page: string) => join(pageDir(page), 'inbox.jsonl');
// Every page folder's copy of one file, where it exists.
const each = (name: string) =>
  existsSync(pagesDir()) ? readdirSync(pagesDir()).map(d => join(pagesDir(), d, name)).filter(f => existsSync(f)) : [];

// Writes via a temporary file and a rename, so a reader never sees half a file.
function writeAtomic(path: string, text: string): void {
  makeDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: PRIVATE_FILE });
  renameSync(tmp, path);
}

// ---------- layout ----------
// 2: page folders end in 16 hex digits (they had 8), and everything is private to the person.
const LAYOUT = 2;
// A page folder named the way this layout names them.
const current = (name: string) => /-[0-9a-f]{16}$/.test(name);

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

// The page key for the web address in a JSON object's url, or null.
const keyIn = (json: string) => {
  const url: unknown = (JSON.parse(json) as { url?: unknown }).url;
  return typeof url === 'string' && originPattern(url) ? pageKey(url) : null;
};

// The page key a page folder belongs to, from its notes' address or else its first message's.
function folderKey(dir: string): string | null {
  try { const key = keyIn(readFileSync(join(dir, 'page.json'), 'utf8')); if (key) return key; } catch { /* no notes */ }
  try { return keyIn(readFileSync(join(dir, 'inbox.jsonl'), 'utf8').split('\n')[0] ?? ''); } catch { return null; }
}

// Moves an old page folder's files into the folder its page has now. When both have a file, the
// newer notes or state win, and inbox messages the new folder lacks are added to it.
function mergeInto(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name), dst = join(to, name);
    if (!existsSync(dst)) renameSync(src, dst);
    else if (name === 'inbox.jsonl') {
      const have = new Set(readFileSync(dst, 'utf8').split('\n').filter(Boolean));
      const add = readFileSync(src, 'utf8').split('\n').filter(l => l && !have.has(l));
      if (add.length) appendFileSync(dst, `${add.join('\n')}\n`, { mode: PRIVATE_FILE });
    } else if (statSync(src).mtimeMs > statSync(dst).mtimeMs) renameSync(src, dst);
  }
  rmSync(from, { recursive: true, force: true });
}

// Makes a folder and its files private. Returns false when that fails for a reason other than
// something having moved meanwhile.
function makePrivate(dir: string): boolean {
  let ok = true;
  for (const path of [dir, ...(existsSync(dir) ? readdirSync(dir).map(f => join(dir, f)) : [])]) {
    try { chmodSync(path, path === dir ? PRIVATE_DIR : PRIVATE_FILE); } catch (e) { if (!isMissing(e)) ok = false; }
  }
  return ok;
}

// Brings the data folder up to LAYOUT. Every start, page folders still named the old way move to
// the name their page key has now: an older helper still running in a browser, or an older tater
// in another session, can create them at any time. Once, everything is made private, and the
// layout file records it. Each step is safe to repeat, so several processes can run it at once,
// and a failure never stops startup: the layout file is written only after a clean run. A folder
// with only a state file can't say its page, so it stays where it is.
export function migrate(): void {
  let have = 1;
  try { have = Number(readFileSync(layoutFile(), 'utf8')) || 1; } catch { /* layout 1, or no data yet */ }
  let clean = true;
  try { makeDir(pagesDir()); } catch { return; }
  for (const name of readdirSync(pagesDir())) {
    if (current(name)) continue;
    const key = folderKey(join(pagesDir(), name));
    if (key === null) continue;
    try {
      const to = pageDir(key);
      if (existsSync(to)) mergeInto(join(pagesDir(), name), to); else renameSync(join(pagesDir(), name), to);
      if (!makePrivate(to)) clean = false;
    } catch (e) {
      if (!isMissing(e)) clean = false; // another process moved it first
    }
  }
  if (have >= LAYOUT) return;
  // The data folder also holds bin and the unpacked Chrome extension, so only it and its own files
  // change here; each page folder gets the whole treatment.
  for (const [path, mode] of [[dataDir(), PRIVATE_DIR], [pagesDir(), PRIVATE_DIR], [deliveredFile(), PRIVATE_FILE]] as const) {
    try { chmodSync(path, mode); } catch (e) { if (!isMissing(e)) clean = false; }
  }
  for (const name of readdirSync(pagesDir())) if (!makePrivate(join(pagesDir(), name))) clean = false;
  if (clean) writeFileSync(layoutFile(), `${LAYOUT}\n`, { mode: PRIVATE_FILE });
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

// ---------- notes ----------
// Refuses notes too big for the browser to take, threads included.
export function savePage(notes: NotesFile): string {
  const size = bytes(notes);
  if (size > MAX_NOTES) throw new Error(`the notes for ${notes.url} would be ${size} bytes; a page's notes, threads included, can be at most ${MAX_NOTES}, so the browser can take them`);
  const path = notesFile(pageKey(notes.url));
  writeAtomic(path, `${JSON.stringify(notes, null, 2)}\n`);
  return path;
}

// Every valid notes file. Invalid ones are reported through onBad and skipped.
export function loadPages(onBad: (file: string, problem: string) => void = () => {}): NotesFile[] {
  const out: NotesFile[] = [];
  for (const file of each('page.json')) {
    try {
      out.push(parseNotes(readFileSync(file, 'utf8')));
    } catch (e) {
      onBad(file, (e as Error).message);
    }
  }
  return out;
}

export function findPage(page: string): NotesFile | null {
  try {
    return parseNotes(readFileSync(notesFile(page), 'utf8'));
  } catch {
    return null;
  }
}

// When anything about the page last changed: its notes, its shared state, or its inbox.
export function pageRev(page: string): number {
  let rev = 0;
  for (const f of [notesFile(page), stateFile(page), inboxFile(page)]) {
    try { rev = Math.max(rev, statSync(f).mtimeMs); } catch { /* not written yet */ }
  }
  return rev;
}

// ---------- shared page state ----------
export function readState(page: string): PageState {
  try {
    return JSON.parse(readFileSync(stateFile(page), 'utf8')) as PageState;
  } catch {
    return { done: {} };
  }
}

// Refuses a change that isn't shaped like page state, or that would take the state past its share
// of the browser's limit.
export function saveState(page: string, patch: Partial<PageState>): void {
  const problems = stateProblems(patch);
  if (problems.length) throw new Error(`refused a state change for ${page}: ${problems.join('; ')}`);
  const { placement, ...next } = mergeState(readState(page), patch);
  if (bytes(next) > MAX_STATE) throw new Error(`the shared state for ${page} would be over ${MAX_STATE} bytes`);
  writeAtomic(stateFile(page), JSON.stringify(placement ? { ...next, placement } : next));
}

// ---------- messages ----------
// Refuses a message that isn't shaped like one from a page (sizes included), or one that would
// take the page's unanswered messages past their share of the browser's limit, which would leave
// the page without its notes.
export function appendInbox(message: Outgoing): void {
  const problems = messageProblems(message);
  if (problems.length) throw new Error(`refused a message: ${problems.join('; ')}`);
  if (bytes([...pending(message.page), message]) > MAX_PENDING) {
    throw new Error(`${message.page} has too many unanswered messages; answer or ack them first`);
  }
  makeDir(pageDir(message.page));
  appendFileSync(inboxFile(message.page), `${JSON.stringify(message)}\n`, { mode: PRIVATE_FILE });
}

const parseLines = (file: string) =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Outgoing);

function readInbox(page: string): Outgoing[] {
  return existsSync(inboxFile(page)) ? parseLines(inboxFile(page)) : [];
}

export function readAllInboxes(): Outgoing[] {
  return each('inbox.jsonl').flatMap(parseLines);
}

// The page's messages the agent hasn't answered or acked yet.
export function pending(page: string): Outgoing[] {
  const acked = new Set(findPage(page)?.acked ?? []);
  return readInbox(page).filter(m => !acked.has(m.id));
}

export function readDelivered(): Set<string> {
  if (!existsSync(deliveredFile())) return new Set();
  return new Set(readFileSync(deliveredFile(), 'utf8').split('\n').filter(Boolean));
}

export function markDelivered(ids: string[]): void {
  if (!ids.length) return;
  makeDir(dataDir());
  appendFileSync(deliveredFile(), `${ids.join('\n')}\n`, { mode: PRIVATE_FILE });
}
