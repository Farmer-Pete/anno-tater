// Small DOM helpers. Nothing here uses innerHTML, so page CSP and Trusted Types don't matter.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, string | number | boolean | null | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = String(v);
    else if (k === 'class') e.className = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  append(e, kids);
  return e;
}

function append(parent: Node, kids: Child[]): void {
  for (const c of kids) {
    if (Array.isArray(c)) append(parent, c);
    else if (c != null && c !== false) parent.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// The markdown subset notes use: `code`, **bold**, and [text](url) inline.
export function inline(text: string): Child[] {
  const out: Child[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(h('code', null, m[1]));
    else if (m[2] != null) out.push(h('strong', null, m[2]));
    else if (/^https?:/.test(m[4] ?? '')) out.push(h('a', { href: m[4], target: '_blank', rel: 'noopener' }, m[3]));
    else out.push(m[3]); // only web links; anything else (javascript:, data:) stays plain text
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Align = 'left' | 'center' | 'right' | null;
type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] }
  | { kind: 'code'; lang: string; text: string };

// A table row's cells. Outer pipes are optional; "\|" is a literal pipe.
const cells = (line = ''): string[] =>
  line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const isRule = (line = '') => line.includes('|') && cells(line).every(c => /^:?-+:?$/.test(c));
const alignOf = (rule: string): Align =>
  rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : rule.startsWith(':') ? 'left' : null;

// Blocks: fenced code (``` with an optional language, up to the closing ``` or the end), then
// paragraphs separated by blank lines, lists of "- " lines, "> " quotes, and tables (a header row,
// a "| --- |" rule with the same number of cells, then rows). A line break inside a paragraph
// stays a line break, as in GitHub comments and in the reply box (Shift+Enter).
export function blocks(src: string | undefined): Block[] {
  const out: Block[] = [];
  const lines = String(src ?? '').split('\n');
  let rest: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}```\s*([\w+#.-]*)/.exec(lines[i] ?? '');
    if (!open) { rest.push(lines[i] ?? ''); continue; }
    prose(rest.join('\n'), out);
    rest = [];
    const close = lines.findIndex((l, j) => j > i && /^ {0,3}```\s*$/.test(l));
    const end = close < 0 ? lines.length : close;
    out.push({ kind: 'code', lang: (open[1] ?? '').toLowerCase(), text: lines.slice(i + 1, end).join('\n') });
    i = end;
  }
  prose(rest.join('\n'), out);
  return out;
}

const lineKind = (l: string) => (/^\s*>/.test(l) ? 'quote' : /^\s*- /.test(l) ? 'ul' : 'p');

function prose(src: string, out: Block[]): void {
  // Runs of quoted lines, list lines, and other lines, in order. A quote's text is parsed again,
  // so it can hold lists, code, or tables.
  const text = (all: string[]) => {
    const lines = all.filter(l => l.trim());
    for (let i = 0; i < lines.length;) {
      const kind = lineKind(lines[i] ?? '');
      let j = i;
      while (j < lines.length && lineKind(lines[j] ?? '') === kind) j++;
      const run = lines.slice(i, j);
      i = j;
      if (kind === 'quote') out.push({ kind, blocks: blocks(run.map(l => l.replace(/^\s*> ?/, '')).join('\n')) });
      else if (kind === 'ul') out.push({ kind, items: run.map(l => l.replace(/^\s*- /, '')) });
      else out.push({ kind, lines: run });
    }
  };
  for (let lines of src.split(/\n{2,}/).map(b => b.split('\n'))) {
    for (let at = tableAt(lines); at >= 0; at = tableAt(lines)) {
      text(lines.slice(0, at));
      const head = cells(lines[at]);
      const rest = lines.slice(at + 2);
      const end = rest.findIndex(l => !l.includes('|'));
      const rows = (end < 0 ? rest : rest.slice(0, end)).map(l => cells(l)).map(row => head.map((_, i) => row[i] ?? ''));
      out.push({ kind: 'table', align: cells(lines[at + 1]).map(alignOf), head, rows });
      lines = end < 0 ? [] : rest.slice(end);
    }
    text(lines);
  }
}

// A light highlighter for fenced code with a named language: comments, strings, numbers, and
// keywords common to most languages. In a diff, added, removed, and hunk lines.
type Token = [kind: 'c' | 's' | 'n' | 'k' | 'add' | 'del' | 'hunk' | null, text: string];
const HASH_COMMENTS = new Set(['py', 'python', 'sh', 'bash', 'zsh', 'shell', 'yaml', 'yml', 'toml', 'rb', 'ruby', 'r', 'pl', 'perl', 'dockerfile', 'make', 'makefile']);
const DASH_COMMENTS = new Set(['sql', 'lua', 'hs', 'haskell']);
const KEYWORDS = 'and|as|async|await|break|case|catch|class|const|continue|def|default|del|do|elif|else|enum|except|export|extends|false|False|finally|fn|for|from|func|function|if|impl|import|in|interface|is|lambda|let|match|mut|new|nil|None|not|null|or|pass|pub|raise|return|self|static|struct|switch|this|throw|true|True|try|type|typeof|undefined|use|var|void|while|with|yield';
export function tokens(lang: string, text: string): Token[] {
  if (lang === 'diff') {
    return text.split('\n').map(l => [l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : null, l]);
  }
  if (!lang) return [[null, text]];
  const comment = HASH_COMMENTS.has(lang) ? '#.*' : DASH_COMMENTS.has(lang) ? '--.*' : '//.*|/\\*[\\s\\S]*?\\*/';
  const re = new RegExp(`(${comment})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(0x[\\da-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?)\\b|\\b(${KEYWORDS})\\b`, 'g');
  const out: Token[] = [];
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push([null, text.slice(last, m.index)]);
    out.push([m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : 'k', m[0]]);
    last = re.lastIndex;
  }
  if (last < text.length) out.push([null, text.slice(last)]);
  return out;
}

function tableAt(lines: string[]): number {
  return lines.findIndex((l, i) => l.includes('|') && isRule(lines[i + 1]) && cells(l).length === cells(lines[i + 1]).length);
}

export const md = (src: string | undefined): DocumentFragment => render(blocks(src));

function render(bs: Block[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of bs) {
    if (b.kind === 'p') frag.append(h('p', null, b.lines.map((l, i) => [i > 0 && h('br'), inline(l)])));
    else if (b.kind === 'quote') frag.append(h('blockquote', null, render(b.blocks)));
    else if (b.kind === 'ul') frag.append(h('ul', null, b.items.map(i => h('li', null, inline(i)))));
    else if (b.kind === 'code') {
      // A diff gets one block per line (empty lines need a space to keep their height).
      const diff = b.lang === 'diff';
      const spans = tokens(b.lang, b.text).map(([k, t]) => (diff ? h('span', { class: k && `tk-${k}` }, t || ' ') : k ? h('span', { class: `tk-${k}` }, t) : t));
      frag.append(h('pre', { class: diff ? 'code diff' : 'code' }, h('code', null, spans)));
    } else {
      const row = (tag: 'th' | 'td', cs: string[]) =>
        h('tr', null, cs.map((c, i) => h(tag, { style: b.align[i] && `text-align:${b.align[i]}` }, inline(c))));
      frag.append(h('div', { class: 'table' }, h('table', null, h('thead', null, row('th', b.head)), h('tbody', null, b.rows.map(r => row('td', r))))));
    }
  }
  return frag;
}
