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
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'table'; align: Align[]; head: string[]; rows: string[][] };

// A table row's cells. Outer pipes are optional; "\|" is a literal pipe.
const cells = (line = ''): string[] =>
  line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const isRule = (line = '') => line.includes('|') && cells(line).every(c => /^:?-+:?$/.test(c));
const alignOf = (rule: string): Align =>
  rule.startsWith(':') && rule.endsWith(':') ? 'center' : rule.endsWith(':') ? 'right' : rule.startsWith(':') ? 'left' : null;

// Blocks: paragraphs separated by blank lines, lists of "- " lines, and tables
// (a header row, a "| --- |" rule with the same number of cells, then rows).
export function blocks(src: string | undefined): Block[] {
  const out: Block[] = [];
  const text = (lines: string[]) => {
    if (!lines.join('').trim()) return;
    if (lines.every(l => /^\s*- /.test(l))) out.push({ kind: 'ul', items: lines.map(l => l.replace(/^\s*- /, '')) });
    else out.push({ kind: 'p', text: lines.join(' ') });
  };
  for (let lines of String(src ?? '').split(/\n{2,}/).map(b => b.split('\n'))) {
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
  return out;
}

function tableAt(lines: string[]): number {
  return lines.findIndex((l, i) => l.includes('|') && isRule(lines[i + 1]) && cells(l).length === cells(lines[i + 1]).length);
}

export function md(src: string | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of blocks(src)) {
    if (b.kind === 'p') frag.append(h('p', null, inline(b.text)));
    else if (b.kind === 'ul') frag.append(h('ul', null, b.items.map(i => h('li', null, inline(i)))));
    else {
      const row = (tag: 'th' | 'td', cs: string[]) =>
        h('tr', null, cs.map((c, i) => h(tag, { style: b.align[i] && `text-align:${b.align[i]}` }, inline(c))));
      frag.append(h('div', { class: 'table' }, h('table', null, h('thead', null, row('th', b.head)), h('tbody', null, b.rows.map(r => row('td', r))))));
    }
  }
  return frag;
}
