// The data folder that the CLI and the helper share. Everything is keyed by page: one notes
// file, one state file, and one inbox per page URL, whatever the browser.
//
//   pages/<page>.json     the page's notes (written by the agent through tater)
//   state/<page>.json     ticked steps and read replies, shared by every browser
//   inbox/<page>.jsonl    the person's messages from the page, one JSON object per line
//   delivered.jsonl       ids of messages an agent has picked up (drives "Claude has it"), one
//                         per line. Append-only, so several writers can't overwrite each other.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pageKey, parseNotes, type NotesFile, type Outgoing } from '../shared/notes.ts';
import type { PageState } from '../shared/protocol.ts';

export const dataDir = () =>
  process.env.ANNO_TATER_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'anno-tater');
const pagesDir = () => join(dataDir(), 'pages');
export const inboxDir = () => join(dataDir(), 'inbox');
const deliveredFile = () => join(dataDir(), 'delivered.jsonl');

// A readable, collision-free file name for a page key.
const fileName = (page: string) =>
  `${page.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x'}-${createHash('sha256').update(page).digest('hex').slice(0, 8)}`;
const notesFile = (page: string) => join(pagesDir(), `${fileName(page)}.json`);
const stateFile = (page: string) => join(dataDir(), 'state', `${fileName(page)}.json`);
const inboxFile = (page: string) => join(inboxDir(), `${fileName(page)}.jsonl`);

// Writes via a temporary file and a rename, so a reader never sees half a file.
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---------- notes ----------
export function savePage(notes: NotesFile): string {
  const path = notesFile(pageKey(notes.url));
  writeAtomic(path, `${JSON.stringify(notes, null, 2)}\n`);
  return path;
}

// Every valid notes file. Invalid ones are reported through onBad and skipped.
export function loadPages(onBad: (file: string, problem: string) => void = () => {}): NotesFile[] {
  if (!existsSync(pagesDir())) return [];
  const out: NotesFile[] = [];
  for (const name of readdirSync(pagesDir())) {
    if (!name.endsWith('.json')) continue;
    try {
      out.push(parseNotes(readFileSync(join(pagesDir(), name), 'utf8')));
    } catch (e) {
      onBad(name, (e as Error).message);
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

// Steps merge per id; the read list is replaced, since the browser sends the whole set.
export function saveState(page: string, patch: Partial<PageState>): void {
  const now = readState(page);
  writeAtomic(stateFile(page), JSON.stringify({ ...now, ...patch, done: { ...now.done, ...patch.done } }));
}

// ---------- messages ----------
export function appendInbox(message: Outgoing): void {
  mkdirSync(inboxDir(), { recursive: true });
  appendFileSync(inboxFile(message.page), `${JSON.stringify(message)}\n`);
}

const parseLines = (file: string) =>
  readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Outgoing);

function readInbox(page: string): Outgoing[] {
  return existsSync(inboxFile(page)) ? parseLines(inboxFile(page)) : [];
}

export function readAllInboxes(): Outgoing[] {
  if (!existsSync(inboxDir())) return [];
  return readdirSync(inboxDir()).filter(f => f.endsWith('.jsonl')).flatMap(f => parseLines(join(inboxDir(), f)));
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
