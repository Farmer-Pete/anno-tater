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

// Blocks: paragraphs separated by blank lines, and lists of "- " lines.
export function md(src: string | undefined): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const block of String(src ?? '').split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (lines.every(l => /^\s*- /.test(l))) frag.append(h('ul', null, lines.map(l => h('li', null, inline(l.replace(/^\s*- /, ''))))));
    else frag.append(h('p', null, inline(block.replace(/\n/g, ' '))));
  }
  return frag;
}
