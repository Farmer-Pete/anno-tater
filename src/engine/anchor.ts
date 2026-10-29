// Turns text quotes into DOM Ranges. The matching itself lives in shared/notes.ts (findQuote);
// this file maps between page text and the text nodes it came from.
import { findQuote, norm, type Term } from '../shared/notes.ts';

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE']);

interface TextIndex {
  text: string;      // the page text with whitespace runs collapsed to one space
  nodes: Text[];     // nodes[i] and offs[i] give the source of text[i]
  offs: number[];
}

export function buildIndex(root: Element): TextIndex {
  const nodes: Text[] = [], offs: number[] = [];
  let text = '', lastSpace = true;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      for (let e = n.parentElement; e && e !== root; e = e.parentElement) if (SKIP.has(e.tagName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const s = n.data;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i] ?? '';
      const ws = /\s/.test(ch);
      if (ws && lastSpace) continue;
      text += ws ? ' ' : ch;
      nodes.push(n); offs.push(i);
      lastSpace = ws;
    }
  }
  return { text, nodes, offs };
}

function rangeAt(idx: TextIndex, start: number, len: number): Range | null {
  const a = idx.nodes[start], b = idx.nodes[start + len - 1], ao = idx.offs[start], bo = idx.offs[start + len - 1];
  if (!a || !b || ao === undefined || bo === undefined) return null;
  const r = document.createRange();
  r.setStart(a, ao);
  r.setEnd(b, bo + 1);
  return r;
}

const visible = (r: Range) => r.getClientRects().length > 0;

// An element's text as one range, without the white space around it; null when it has no text.
export function textRange(el: Element): Range | null {
  const idx = buildIndex(el);
  const len = idx.text.trimEnd().length;
  return len ? rangeAt(idx, 0, len) : null;
}

// The best visible match for a note's quote, or null when the quote isn't on the page. With an
// endQuote, the range runs on through the first endQuote after the quote. matches counts every
// place the quote occurs.
export function anchor(idx: TextIndex, note: { quote: string; endQuote?: string; prefix?: string; suffix?: string }): { range: Range; ambiguous: boolean; matches: number } | null {
  const { hits, ambiguous } = findQuote(idx.text, note);
  const len = norm(note.quote).length, end = norm(note.endQuote);
  const through = (i: number) => {
    if (!end) return rangeAt(idx, i, len);
    const e = idx.text.indexOf(end, i + len);
    return e < 0 ? null : rangeAt(idx, i, e + end.length - i);
  };
  const ranges = hits.map(through).filter((r): r is Range => r !== null);
  const pick = ranges.find(visible) ?? ranges[0];
  return pick ? { range: pick, ambiguous, matches: hits.length } : null;
}

// Every visible use of each glossary term, as a whole word.
export function findTerms(idx: TextIndex, glossary: Term[] = [], perTerm = 300): { term: Term; range: Range }[] {
  const out: { term: Term; range: Range }[] = [];
  for (const term of glossary) {
    const re = new RegExp(`(?<![\\w-])${term.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
    let n = 0;
    for (let m = re.exec(idx.text); m && n < perTerm; m = re.exec(idx.text)) {
      const r = rangeAt(idx, m.index, m[0].length);
      if (r && visible(r)) { out.push({ term, range: r }); n++; }
    }
  }
  return out;
}

// About n characters of page text before and after a range, so an answer can anchor on the exact spot.
export function context(root: Element, range: Range, n = 32): { prefix: string; suffix: string } {
  const before = document.createRange(), after = document.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(root, root.childNodes.length);
  return { prefix: norm(before.toString()).slice(-n), suffix: norm(after.toString()).slice(0, n) };
}
