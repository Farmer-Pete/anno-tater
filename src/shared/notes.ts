// The notes file format, shared by the CLI, the helper, and the extension.
// No Node or DOM imports: this file runs in all three.

const KINDS = ['issue', 'caution', 'agree', 'info', 'step'] as const;
export type Kind = (typeof KINDS)[number];
const DECORATIONS = ['box', 'circle', 'underline', 'bracket'] as const;
type Decoration = (typeof DECORATIONS)[number];

interface Message {
  from: 'you' | 'claude';
  text: string;
}

export interface Note {
  id: string;
  kind: Kind;
  quote?: string; // none: a note about the whole page, listed at the top of the panel
  prefix?: string;
  suffix?: string;
  title?: string;
  body?: string;
  step?: number;
  decorate?: Decoration;
  thread?: Message[];
  posted?: string; // the published comment this note became (set by tater mark)
}

// A link joins two notes: on this page (an arrow down the margin), or on another page (a row in
// the note's card that opens that page at the note).
interface Link {
  from: string;
  to: string | { url: string; note: string };
  label?: string;
}

export interface Term {
  term: string;
  def: string;
}

// One page's notes. The page URL is the key: one notes file, one shared state, and one
// conversation per page, whatever the browser.
export interface NotesFile {
  url: string;
  title?: string;
  scope?: string;
  commit?: string; // on a pull request, the head commit the notes were written for
  notes: Note[];
  links?: Link[];
  glossary?: Term[];
  glossaryFiles?: string[]; // shared glossaries, relative to the notes file; tater merges them into glossary
  acked?: string[];
  session?: string; // the agent session that last pushed these notes (managed by tater)
}

// What the page sends back. The helper appends these to the page's inbox.
export interface Outgoing {
  id: string;
  at: string;
  page: string; // the page key (pageKey of url)
  url: string; // the full address it was sent from
  kind: 'reply' | 'ask' | 'done' | 'undone';
  noteId: string | null;
  quote?: string;
  prefix?: string;
  suffix?: string;
  text: string | null;
}

// ---------- validation ----------

type Problems = string[];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || str(v);

function checkNote(n: unknown, at: string, problems: Problems): void {
  if (!isObj(n)) { problems.push(`${at} is not an object`); return; }
  if (!str(n.id) || !n.id) problems.push(`${at}.id must be a non-empty string`);
  if (!KINDS.includes(n.kind as Kind)) problems.push(`${at}.kind must be one of ${KINDS.join(', ')}`);
  if (n.quote !== undefined && (!str(n.quote) || !String(n.quote).trim())) problems.push(`${at}.quote must be non-empty text from the page, or left out for a note about the whole page`);
  for (const k of ['prefix', 'suffix', 'title', 'body'] as const) if (!optStr(n[k])) problems.push(`${at}.${k} must be a string`);
  if (n.kind === 'step' && typeof n.step !== 'number') problems.push(`${at}.step must be a number for a step`);
  if (n.posted !== undefined && !(str(n.posted) && originPattern(n.posted))) problems.push(`${at}.posted must be the http(s) address of the posted comment`);
  if (n.decorate !== undefined && !DECORATIONS.includes(n.decorate as Decoration)) problems.push(`${at}.decorate must be one of ${DECORATIONS.join(', ')}`);
  if (n.thread !== undefined) {
    if (!Array.isArray(n.thread)) problems.push(`${at}.thread must be a list`);
    else n.thread.forEach((m, i) => {
      if (!isObj(m) || (m.from !== 'you' && m.from !== 'claude') || !str(m.text)) problems.push(`${at}.thread[${i}] needs from ("you" or "claude") and text`);
    });
  }
}

// Problems with a list of glossary terms.
export function glossaryProblems(v: unknown, at: string): Problems {
  if (!Array.isArray(v)) return [`${at} must be a list`];
  return v.flatMap((g, i) => (!isObj(g) || !str(g.term) || !g.term || !str(g.def) ? [`${at}[${i}] needs term and def`] : []));
}

// Returns the problems found. An empty list means the value is a valid NotesFile.
export function validate(v: unknown): Problems {
  const problems: Problems = [];
  if (!isObj(v)) return ['the notes file must be a JSON object'];
  if (!str(v.url) || !originPattern(String(v.url))) problems.push('url must be the http(s) address of the page');
  for (const k of ['title', 'scope', 'session'] as const) if (!optStr(v[k])) problems.push(`${k} must be a string`);
  if (v.commit !== undefined && !(str(v.commit) && /^[0-9a-f]{7,40}$/i.test(v.commit))) problems.push('commit must be a commit SHA (7 to 40 hex digits)');
  if (!Array.isArray(v.notes)) problems.push('notes must be a list');
  else {
    v.notes.forEach((n, i) => checkNote(n, `notes[${i}]`, problems));
    const ids = v.notes.map(n => (isObj(n) ? n.id : undefined));
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) problems.push(`note ids repeat: ${[...new Set(dupes)].join(', ')}`);
    if (Array.isArray(v.links)) {
      const known = new Set(ids);
      v.links.forEach((l, i) => {
        const away = isObj(l) && isObj(l.to) && str(l.to.url) && originPattern(l.to.url) !== null && str(l.to.note) && l.to.note !== '';
        if (!isObj(l) || !known.has(l.from) || !(known.has(l.to) || away)) problems.push(`links[${i}] must join a note id to a note id, or to { url, note } on another page`);
      });
    } else if (v.links !== undefined) problems.push('links must be a list');
  }
  if (v.glossary !== undefined) problems.push(...glossaryProblems(v.glossary, 'glossary'));
  if (v.glossaryFiles !== undefined && !(Array.isArray(v.glossaryFiles) && v.glossaryFiles.every(str))) problems.push('glossaryFiles must be a list of file paths');
  if (v.acked !== undefined && !(Array.isArray(v.acked) && v.acked.every(str))) problems.push('acked must be a list of message ids');
  return problems;
}

export function parseNotes(json: string): NotesFile {
  let v: unknown;
  try { v = JSON.parse(json); } catch (e) { throw new Error(`not valid JSON: ${(e as Error).message}`, { cause: e }); }
  const problems = validate(v);
  if (problems.length) throw new Error(problems.join('\n'));
  return v as NotesFile;
}

// ---------- pages ----------

// The key for a page: its address without the scheme or the #fragment. The query string stays,
// since it can change what a page shows (GitHub's ?plain=1). A fragment route stays too
// (#/settings, #!/settings): single-page apps use it to pick the page. A bare #/ is the root.
export function pageKey(url: string): string {
  const bare = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = bare.indexOf('#');
  if (at === -1) return bare;
  const route = /^#(!?\/[^#]*)/.exec(bare.slice(at))?.[1];
  return bare.slice(0, at) + (route && route !== '/' && route !== '!/' ? `#${route}` : '');
}

// The origin pattern a browser permission needs for a URL, e.g. "https://github.com/*".
export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.hostname}/*` : null;
  } catch {
    return null;
  }
}

// ---------- text anchoring (the DOM-free half) ----------

// A short fingerprint of everything anchoring depends on, so a placement report can be matched to
// the notes it was made from. FNV-1a, as hex.
export function anchorsKey(notes: Pick<NotesFile, 'scope' | 'notes'>): string {
  const text = JSON.stringify([notes.scope, notes.notes.map(n => [n.id, n.quote, n.prefix, n.suffix])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export const norm = (s: string | undefined) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Offsets in `text` where `quote` occurs, best first: by how much of the prefix and suffix
// match around each hit. `ambiguous` is true when the top two tie.
export function findQuote(text: string, sel: { quote: string; prefix?: string; suffix?: string }, limit = 100) {
  const quote = norm(sel.quote);
  if (!quote) return { hits: [] as number[], ambiguous: false };
  const hits: number[] = [];
  for (let i = text.indexOf(quote); i !== -1 && hits.length < limit; i = text.indexOf(quote, i + 1)) hits.push(i);
  const pre = norm(sel.prefix), suf = norm(sel.suffix);
  const score = (i: number) => {
    const before = text.slice(Math.max(0, i - pre.length - 1), i).trimEnd();
    const after = text.slice(i + quote.length).trimStart();
    let s = 0;
    for (let k = 1; k <= pre.length && before.endsWith(pre.slice(-k)); k++) s++;
    for (let k = 1; k <= suf.length && after.startsWith(suf.slice(0, k)); k++) s++;
    return s;
  };
  const scored = hits.map(i => ({ i, s: score(i) })).toSorted((a, b) => b.s - a.s);
  return { hits: scored.map(h => h.i), ambiguous: scored.length > 1 && scored[0]?.s === scored[1]?.s };
}

// ---------- notes in a URL fragment (no-helper mode) ----------

const toB64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64Url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeFragment(notes: NotesFile): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(notes));
  return toB64Url(await pipe(json, new CompressionStream('gzip')));
}

export async function decodeFragment(fragment: string): Promise<NotesFile> {
  return parseNotes(new TextDecoder().decode(await pipe(fromB64Url(fragment), new DecompressionStream('gzip'))));
}
