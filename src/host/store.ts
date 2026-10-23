// The data folder that the CLI and the helper share. Agents write notes files here; the
// helper appends the person's messages to the inbox of the channel that wrote the note.
//
//   pages/<channel>/<page>.json   a channel's notes for one page (a channel is a random UUID)
//   inbox/<channel>.jsonl         messages for that channel, one JSON object per line
//   delivered.jsonl               ids of messages an agent has picked up (drives "Claude has it"),
//                                 one per line. Append-only, so several `tater watch` processes
//                                 can't overwrite each other.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseNotes, type NotesFile, type Outgoing } from '../shared/notes.ts';

export const dataDir = () =>
  process.env.ANNO_TATER_HOME ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'anno-tater');
export const pagesDir = () => join(dataDir(), 'pages');
export const inboxDir = () => join(dataDir(), 'inbox');
export const DELIVERED = 'delivered.jsonl';
const deliveredFile = () => join(dataDir(), DELIVERED);

const safeName = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';
const shortHash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 8);

// Writes via a temporary file and a rename, so a reader never sees half a file.
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

// ---------- channels ----------
// Channel ids become folder and file names, so only UUIDs are accepted.
const isChannel = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
const channelDir = (channel: string) => join(pagesDir(), channel);

export function newChannel(): string {
  const channel = randomUUID();
  mkdirSync(channelDir(channel), { recursive: true });
  return channel;
}

export const channelExists = (channel: string) => isChannel(channel) && existsSync(channelDir(channel));

export function channels(): string[] {
  return existsSync(pagesDir()) ? readdirSync(pagesDir()).filter(isChannel) : [];
}

// ---------- notes files ----------
export function pageFile(channel: string, match: string): string {
  if (!isChannel(channel)) throw new Error(`not a channel id: ${channel}`);
  return join(channelDir(channel), `${safeName(match)}-${shortHash(match)}.json`);
}

export function savePage(notes: NotesFile & { channel: string }): string {
  const path = pageFile(notes.channel, notes.match);
  mkdirSync(channelDir(notes.channel), { recursive: true });
  writeAtomic(path, `${JSON.stringify(notes, null, 2)}\n`);
  return path;
}

// Every valid notes file, each carrying the channel of the folder it's in. Invalid ones are
// reported through onBad and skipped.
export function loadPages(onBad: (file: string, problem: string) => void = () => {}): (NotesFile & { channel: string })[] {
  const out: (NotesFile & { channel: string })[] = [];
  for (const channel of channels()) {
    for (const name of readdirSync(channelDir(channel))) {
      if (!name.endsWith('.json')) continue;
      try {
        out.push({ ...parseNotes(readFileSync(join(channelDir(channel), name), 'utf8')), channel });
      } catch (e) {
        onBad(`${channel}/${name}`, (e as Error).message);
      }
    }
  }
  return out;
}

export function findPage(channel: string, match: string): (NotesFile & { channel: string }) | null {
  return loadPages().find(p => p.channel === channel && p.match === match) ?? null;
}

// ---------- messages ----------
const inboxFile = (channel: string) => {
  if (!isChannel(channel)) throw new Error(`not a channel id: ${channel}`);
  return join(inboxDir(), `${channel}.jsonl`);
};

export function appendInbox(message: Outgoing): void {
  mkdirSync(inboxDir(), { recursive: true });
  appendFileSync(inboxFile(message.channel), `${JSON.stringify(message)}\n`);
}

export function readInbox(channel: string): Outgoing[] {
  const file = inboxFile(channel);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Outgoing);
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
