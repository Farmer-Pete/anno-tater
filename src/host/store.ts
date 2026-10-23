// The data folder that the CLI and the helper share. Agents write notes files here; the
// helper appends the person's messages to an inbox file per owner.
//
//   pages/<name>.json      one notes file per page
//   inbox/<owner>.jsonl    messages from the page, one JSON object per line
//   delivered.json         ids of messages an agent has picked up (drives "Claude has it")
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseNotes, type NotesFile, type Outgoing } from '../shared/notes.ts';

export const dataDir = () =>
  process.env.ANNO_TATER_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'anno-tater');
export const pagesDir = () => join(dataDir(), 'pages');
export const inboxDir = () => join(dataDir(), 'inbox');
const deliveredFile = () => join(dataDir(), 'delivered.json');

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

// Writes via a temporary file and a rename, so a reader never sees half a file.
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function pageFile(match: string): string {
  const hash = createHash('sha256').update(match).digest('hex').slice(0, 8);
  return join(pagesDir(), `${safeName(match)}-${hash}.json`);
}

export function savePage(notes: NotesFile): string {
  mkdirSync(pagesDir(), { recursive: true });
  const path = pageFile(notes.match);
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

export function findPage(match: string): NotesFile | null {
  return loadPages().find(p => p.match === match) ?? null;
}

const inboxFile = (owner: string) => join(inboxDir(), `${safeName(owner)}.jsonl`);

export function appendInbox(message: Outgoing): void {
  mkdirSync(inboxDir(), { recursive: true });
  appendFileSync(inboxFile(message.owner), `${JSON.stringify(message)}\n`);
}

export function readInbox(owner: string): Outgoing[] {
  const file = inboxFile(owner);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Outgoing);
}

export function readDelivered(): Set<string> {
  try {
    return new Set(JSON.parse(readFileSync(deliveredFile(), 'utf8')) as string[]);
  } catch {
    return new Set();
  }
}

export function markDelivered(ids: string[]): void {
  if (!ids.length) return;
  mkdirSync(dataDir(), { recursive: true });
  writeAtomic(deliveredFile(), JSON.stringify([...new Set([...readDelivered(), ...ids])]));
}
