// The data folder that the CLI and the helper share. Everything is keyed by page: one folder per
// page URL, whatever the browser.
//
//   data/<page>/page.json     the page's notes (written by the agent through tater)
//   data/<page>/state.json    ticked steps and read replies, shared by every browser
//   data/<page>/inbox.jsonl   the person's messages from the page, one JSON object per line
//   delivered.jsonl           ids of messages an agent has picked up (drives "Claude has it"), one
//                             per line. Append-only, so several writers can't overwrite each other.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_QUOTE, MAX_TEXT, pageKey, parseNotes, type NotesFile, type Outgoing } from '../shared/notes.ts';
import { mergeState, type PageState } from '../shared/protocol.ts';
import { MAX_NOTES, MAX_PENDING, MAX_STATE } from './framing.ts';

export const dataDir = () =>
  process.env.ANNO_TATER_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'anno-tater');
export const pagesDir = () => join(dataDir(), 'data');
const deliveredFile = () => join(dataDir(), 'delivered.jsonl');

// A readable, collision-free file name for a page key.
const fileName = (page: string) =>
  `${page.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x'}-${createHash('sha256').update(page).digest('hex').slice(0, 8)}`;
export const pageDir = (page: string) => join(pagesDir(), fileName(page));
const notesFile = (page: string) => join(pageDir(page), 'page.json');
const stateFile = (page: string) => join(pageDir(page), 'state.json');
const inboxFile = (page: string) => join(pageDir(page), 'inbox.jsonl');
// Every page folder's copy of one file, where it exists.
const each = (name: string) =>
  existsSync(pagesDir()) ? readdirSync(pagesDir()).map(d => join(pagesDir(), d, name)).filter(f => existsSync(f)) : [];

// Writes via a temporary file and a rename, so a reader never sees half a file.
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
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

// Refuses a change that would take the state past its share of the browser's limit.
export function saveState(page: string, patch: Partial<PageState>): void {
  const { placement, ...next } = mergeState(readState(page), patch);
  if (bytes(next) > MAX_STATE) throw new Error(`the shared state for ${page} would be over ${MAX_STATE} bytes`);
  writeAtomic(stateFile(page), JSON.stringify(placement ? { ...next, placement } : next));
}

// ---------- messages ----------
// Refuses a message over the size limits, or one that would take the page's unanswered messages
// past their share of the browser's limit, which would leave the page without its notes.
export function appendInbox(message: Outgoing): void {
  if ((message.text?.length ?? 0) > MAX_TEXT || (message.quote?.length ?? 0) > MAX_QUOTE) throw new Error(`message ${message.id} is over the size limit`);
  if (bytes([...pending(message.page), message]) > MAX_PENDING) {
    throw new Error(`${message.page} has too many unanswered messages; answer or ack them first`);
  }
  mkdirSync(pageDir(message.page), { recursive: true });
  appendFileSync(inboxFile(message.page), `${JSON.stringify(message)}\n`);
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
  mkdirSync(dataDir(), { recursive: true });
  appendFileSync(deliveredFile(), `${ids.join('\n')}\n`);
}
