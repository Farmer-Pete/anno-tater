// The page engine: draws a notes file onto the page and collects the person's replies.
//
// - Text highlights use the CSS Custom Highlight API, which paints ranges without touching the
//   DOM, so a page that re-renders its own nodes can't erase them.
// - Everything else (cards, panel, pins, arrows) lives in one shadow root.
// - Highlights have no DOM, so hover and click find the note under the pointer themselves.
import { autoUpdate, computePosition, flip, offset, shift, type VirtualElement } from '@floating-ui/dom';
import { getBoxToBoxArrow } from 'perfect-arrows';
import { annotate } from 'rough-notation';
import { norm, pageKey as keyOf, type Kind, type Note, type NotesFile, type Outgoing, type Term } from '../shared/notes.ts';
import type { PageState } from '../shared/protocol.ts';
import { anchor, buildIndex, context, findTerms } from './anchor.ts';
import { h, inline, md, svg } from './dom.ts';
import { POTATO } from './potato.ts';
import { ACCENT, KINDS, PAGE_CSS, UI_CSS } from './styles.ts';

// Synchronous key-value storage. The content script loads it before the engine starts and saves writes.
export interface Store {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

export type Draft = Pick<Outgoing, 'kind' | 'noteId' | 'quote' | 'prefix' | 'suffix' | 'text'>;

// What the page shares across browsers (through the helper), plus the messages still waiting.
interface Loaded {
  twoWay: boolean;
  state: PageState;
  pending: Outgoing[];
}

export interface Engine {
  load(notes: NotesFile | null, loaded: Loaded): void;
  setDelivered(ids: string[]): void;
  setTwoWay(on: boolean): void;
  setHidden(on: boolean): void;
  isHidden(): boolean;
  start(): void;
  destroy(): void;
}

type RoughAnnotation = ReturnType<typeof annotate>;
type RoughAnnotationConfig = Parameters<typeof annotate>[1];
interface Placed { note: Note; range: Range; ambiguous: boolean }
interface TermHit { term: Term; range: Range }
interface Mark { p: Placed; proxy: HTMLDivElement; ann: RoughAnnotation | null; type: string; last: string }

const kindOf = (n: Note) => KINDS[n.kind] ?? KINDS.info;
// Per-page UI state is keyed by the page's URL: with several channels on a page, no single notes
// file names it.
const pageKey = (k: string) => `page:${keyOf(location.href)}:${k}`;
const isEditable = (el: EventTarget | undefined) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

const rangeRef = (range: Range): VirtualElement => ({
  getBoundingClientRect: () => range.getBoundingClientRect(),
  getClientRects: () => range.getClientRects(),
  contextElement: range.startContainer.parentElement ?? undefined,
});
function float(el: HTMLElement, ref: VirtualElement, placement: 'bottom-start' | 'top-start' | 'top' = 'bottom-start'): () => void {
  return autoUpdate(ref, el, () => {
    void computePosition(ref, el, { placement, strategy: 'fixed', middleware: [offset(8), flip(), shift({ padding: 8 })] })
      .then(({ x, y }) => { el.style.left = `${x}px`; el.style.top = `${y}px`; });
  });
}

const claudeKeys = (n: Note) => (n.thread ?? []).flatMap((m, i) => (m.from === 'claude' ? [`${n.id}#${i}`] : []));

const pageRect = (r: DOMRect) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });

// How many lines a range covers (its client rects, grouped by top edge).
const lineCount = (range: Range) => new Set([...range.getClientRects()].map(r => Math.round(r.top))).size;

const blockOf = (range: Range) =>
  range.startContainer.parentElement?.closest('p, li, td, th, pre, h1, h2, h3, h4, h5, h6, div') ?? range.startContainer.parentElement;

function stepArrow(from: { x: number; y: number; w: number; h: number }, to: { x: number; y: number; w: number; h: number }): SVGGElement {
  const [sx, sy, cx, cy, ex, ey, ae] = getBoxToBoxArrow(from.x, from.y, from.w, from.h, to.x, to.y, to.w, to.h, { bow: 0.25, padStart: 2, padEnd: 6 });
  const g = svg('g');
  g.append(
    svg('path', { d: `M${sx},${sy} Q${cx},${cy} ${ex},${ey}`, fill: 'none', stroke: ACCENT, 'stroke-width': 2 }),
    svg('polygon', { points: '0,-5 10,0 0,5', fill: ACCENT, transform: `translate(${ex},${ey}) rotate(${((ae ?? 0) * 180) / Math.PI})` }));
  return g;
}

function potatoIcon(): SVGSVGElement {
  const icon = svg('svg', { viewBox: POTATO.viewBox, width: 18, height: 18 });
  icon.append(svg('path', { d: POTATO.body, fill: POTATO.fill, stroke: POTATO.stroke, 'stroke-width': 3 }));
  for (const [x, y, r] of POTATO.eyes) icon.append(svg('circle', { cx: x, cy: y, r, fill: POTATO.stroke }));
  return icon;
}

const label = (n: Note) => (n.kind === 'step' ? `Step ${n.step}` : kindOf(n).label);

// store keeps this browser's view settings; send and saveState go to the helper (or, without it,
// to this browser's storage) through the content script.
export function createEngine(store: Store, send: (draft: Draft) => Outgoing, saveState: (patch: Partial<PageState>) => void): Engine {
  let data: NotesFile | null = null;
  let twoWay = false;
  let placed: Placed[] = [];
  let unplaced: Note[] = [];
  let terms: TermHit[] = [];
  let marks: Mark[] = [];
  let pins: HTMLDivElement[] = [];
  let delivered = new Set<string>();
  const drafts: Record<string, string> = {};
  const cleanups: (() => void)[] = [];
  let dead = false, started = false;
  let activeHighlight: Highlight | null = null;

  // View settings stay in this browser: hidden is per page, shortcut blocking and the panel are global.
  const hidden = () => store.get(pageKey('hidden'), false);
  const blockKeys = () => store.get('block-keys', true);
  const panelOpen = () => store.get('panel-open', true);
  // Ticked steps and read replies are shared by every browser that shows this page.
  let state: PageState = { done: {} };
  const isDone = (id: string) => state.done[id] ?? false;
  function setDone(id: string, on: boolean): void {
    state = { ...state, done: { ...state.done, [id]: on } };
    saveState({ done: { [id]: on } });
  }
  const acked = () => new Set(data?.acked ?? []);
  // Messages waiting for an answer: the helper's list, plus ones sent since it was last read.
  let pending: Outgoing[] = [];
  let sentSince: Outgoing[] = [];
  const outbox = () => {
    const ids = new Set(pending.map(m => m.id));
    return [...pending, ...sentSince.filter(m => !ids.has(m.id))].filter(m => !acked().has(m.id));
  };

  // ---------- host element, styles ----------
  const pageSheet = new CSSStyleSheet();
  pageSheet.replaceSync(PAGE_CSS);
  const host = h('div', { id: 'anno-tater-host', style: 'position:absolute;top:0;left:0;width:0;height:0;z-index:2147483646;' });
  const shadow = host.attachShadow({ mode: 'open' });
  const uiSheet = new CSSStyleSheet();
  uiSheet.replaceSync(UI_CSS);
  shadow.adoptedStyleSheets = [uiSheet];
  const marksLayer = h('div', { class: 'marks' });
  const arrowSvg = svg('svg', { class: 'arrows', width: 1, height: 1 });
  marksLayer.append(arrowSvg);
  const ui = h('div', { class: 'ui' });
  shadow.append(marksLayer, ui);

  // ---------- keys ----------
  // Registered now, at document_start, so it runs before the page's own listeners. Keys typed in
  // our UI never reach the page: from its side they look like they come from a plain element, so
  // its shortcuts would fire. With blocking on, the page gets no keys outside its own text fields.
  function onKey(e: KeyboardEvent): void {
    if (!data) return;
    const path = e.composedPath();
    const inOurUi = path.includes(host);
    if (e.type === 'keydown') {
      if (e.key === 'Escape') { closeCard(); hideAsk(); }
      if (e.altKey && e.shiftKey && e.code === 'KeyH') { e.preventDefault(); setHidden(!hidden()); }
      // Enter sends, Shift+Enter adds a line. Handled here because stopImmediatePropagation below
      // keeps the event from reaching the textarea.
      const box = path[0];
      if (inOurUi && e.key === 'Enter' && !e.shiftKey && !e.isComposing && box instanceof HTMLTextAreaElement && submitters.has(box)) {
        e.preventDefault();
        submitters.get(box)?.();
      }
    }
    if (inOurUi || (blockKeys() && !isEditable(path[0]))) e.stopImmediatePropagation();
  }
  const submitters = new WeakMap<HTMLTextAreaElement, () => void>();
  for (const t of ['keydown', 'keypress', 'keyup'] as const) {
    addEventListener(t, onKey, true);
    cleanups.push(() => removeEventListener(t, onKey, true));
  }

  // ---------- floating pieces ----------

  let tip: HTMLElement | null = null, tipStop: (() => void) | null = null;
  function showTip(ref: VirtualElement, kids: Node[]): void {
    hideTip();
    tip = h('div', { class: 'tip' }, kids);
    ui.append(tip);
    tipStop = float(tip, ref, 'top-start');
  }
  function hideTip(): void { tipStop?.(); tipStop = null; tip?.remove(); tip = null; }

  // ---------- unread replies ----------
  // A reply is "<noteId>#<index in thread>"; it's unread until its note's card is opened.
  function seen(): Set<string> {
    if (!state.seen) { // the page's first showing anywhere: nothing is new yet
      state = { ...state, seen: (data?.notes ?? []).flatMap(claudeKeys) };
      saveState({ seen: state.seen });
    }
    return new Set(state.seen);
  }
  const unreadNotes = () => { const s = seen(); return (data?.notes ?? []).filter(n => claudeKeys(n).some(k => !s.has(k))); };
  function markSeen(n: Note): boolean {
    const s = seen(), keys = claudeKeys(n);
    if (keys.every(k => s.has(k))) return false;
    keys.forEach(k => s.add(k));
    state = { ...state, seen: [...s] };
    saveState({ seen: state.seen });
    return true;
  }

  // ---------- sending ----------
  function sendDraft(draft: Draft): void {
    sentSince = [...sentSince, send(draft)];
    renderPanel();
  }
  const pendingLabel = (id: string) => (delivered.has(id) ? 'Claude has it, reply coming' : 'Sent, waiting for Claude to pick it up');

  // ---------- cards ----------
  let card: HTMLElement | null = null, cardStop: (() => void) | null = null, cardNoteId: string | null = null;
  function closeCard(): void { cardStop?.(); cardStop = null; card?.remove(); card = null; cardNoteId = null; setActive(null); }

  function threadView(noteId: string): HTMLElement | null {
    const note = data?.notes.find(n => n.id === noteId);
    const msgs: { from: string; text: string; status?: string }[] = [...(note?.thread ?? [])];
    for (const m of outbox()) if (m.noteId === noteId && m.text) msgs.push({ from: 'you', text: m.text, status: pendingLabel(m.id) });
    if (!msgs.length) return null;
    return h('div', { class: 'section' }, msgs.map(m =>
      h('div', { class: `msg ${m.from === 'claude' ? 'claude' : ''}` },
        h('div', { class: 'who' }, m.from === 'claude' ? 'Claude' : 'You', m.status && h('span', { class: 'status' }, ` · ${m.status}`)),
        md(m.text))));
  }

  function termsIn(range: Range): Term[] {
    const names = new Set<string>();
    return terms.filter(t => {
      let inside = false;
      try { inside = range.isPointInRange(t.range.startContainer, t.range.startOffset); } catch { inside = false; }
      if (!inside || names.has(t.term.term)) return false;
      names.add(t.term.term);
      return true;
    }).map(t => t.term);
  }

  function replyBox(placeholder: string, onSubmit: (text: string) => void, draftKey: string): HTMLElement[] {
    if (!twoWay) return [h('div', { class: 'hint' }, 'Replies need the Anno Tater helper. Run ', h('code', null, 'npm run tater -- install'), ' once.')];
    const ta = h('textarea', { placeholder });
    ta.value = drafts[draftKey] ?? '';
    ta.addEventListener('input', () => { drafts[draftKey] = ta.value; });
    const submit = () => {
      const text = ta.value.trim();
      if (!text) return;
      drafts[draftKey] = '';
      onSubmit(text);
    };
    submitters.set(ta, submit);
    return [ta, h('div', { class: 'row' }, h('button', { class: 'b primary', onclick: submit }, 'Send to Claude'))];
  }

  function openCard(p: Placed): void {
    const wasTyping = !!card && shadow.activeElement instanceof HTMLTextAreaElement;
    closeCard();
    const { note, range } = p;
    const defs = termsIn(range);
    const step = note.kind === 'step';
    card = h('div', { class: 'card' },
      h('button', { class: 'x', title: 'Close (Esc)', onclick: closeCard }, '×'),
      h('div', { class: 'k', style: `color:${kindOf(note).color}` }, label(note)),
      h('h3', null, inline(note.title ?? '')),
      md(note.body),
      defs.length > 0 && h('div', { class: 'section' }, h('div', { class: 'k', style: `color:${ACCENT}` }, 'Terms here'),
        defs.map(g => h('p', null, h('strong', null, g.term), ': ', inline(g.def)))),
      threadView(note.id),
      ...replyBox('Reply to Claude… (Enter to send, Shift+Enter for a new line)', text => {
        sendDraft({ kind: 'reply', noteId: note.id, quote: note.quote, text });
        openCard(p);
      }, note.id),
      step && h('div', { class: 'row' }, h('button', { class: 'b', onclick: () => toggleDone(note) }, isDone(note.id) ? 'Mark not done' : 'Mark done')));
    ui.append(card);
    cardNoteId = note.id;
    cardStop = float(card, rangeRef(range));
    setActive(range);
    if (markSeen(note)) { card.scrollTop = card.scrollHeight; renderPanel(); }
    updateToast();
    const ta = card.querySelector('textarea');
    if (wasTyping && ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }

  function toggleDone(note: Note): void {
    const on = !isDone(note.id);
    setDone(note.id, on);
    if (twoWay) sendDraft({ kind: on ? 'done' : 'undone', noteId: note.id, text: null });
    const p = placed.find(q => q.note.id === note.id);
    if (p && cardNoteId === note.id) openCard(p);
    renderPins(); layout(); renderPanel();
  }

  function setActive(range: Range | null): void {
    const a = new Highlight();
    if (range) a.add(range);
    a.priority = 10;
    activeHighlight = a;
    if (!hidden()) CSS.highlights.set('at-active', a);
  }

  // ---------- "Ask Claude" on a selection ----------
  let askBtn: HTMLElement | null = null, askStop: (() => void) | null = null;
  function hideAsk(): void { askStop?.(); askStop = null; askBtn?.remove(); askBtn = null; }
  function onMouseUp(e: MouseEvent): void {
    if (!data || !twoWay || hidden() || e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = document.getSelection();
      hideAsk();
      if (!sel || sel.isCollapsed || !norm(sel.toString())) return;
      const range = sel.getRangeAt(0).cloneRange();
      askBtn = h('div', { class: 'ask' }, h('button', { onclick: () => { hideAsk(); openAsk(range); } }, 'Ask Claude'));
      ui.append(askBtn);
      askStop = float(askBtn, rangeRef(range), 'top');
    }, 0);
  }
  function openAsk(range: Range): void {
    closeCard();
    const quote = norm(range.toString());
    const { prefix, suffix } = context(scopeRoot(), range);
    card = h('div', { class: 'card' },
      h('button', { class: 'x', onclick: closeCard }, '×'),
      h('div', { class: 'k', style: `color:${ACCENT}` }, 'Ask Claude'),
      h('div', { class: 'quote' }, quote.length > 240 ? `${quote.slice(0, 240)}…` : quote),
      ...replyBox('What do you want to ask about this? (Enter to send)', text => {
        sendDraft({ kind: 'ask', noteId: null, quote, prefix, suffix, text });
        closeCard();
      }, `ask:${quote}`));
    ui.append(card);
    cardStop = float(card, rangeRef(range));
    setActive(range);
    card.querySelector('textarea')?.focus();
  }

  // ---------- hit testing ----------
  function hitAt(x: number, y: number): { p: Placed | null; t: TermHit | null } | null {
    const pos = document.caretPositionFromPoint?.(x, y);
    const node = pos?.offsetNode, off = pos?.offset ?? 0;
    if (!node) return null;
    const inRects = (r: Range) => [...r.getClientRects()].some(c => x >= c.left && x <= c.right && y >= c.top && y <= c.bottom);
    const test = (r: Range) => { try { return r.isPointInRange(node, off) && inRects(r); } catch { return false; } };
    // A note and a glossary term can overlap, so report both.
    const p = placed.find(q => test(q.range)) ?? null;
    const t = terms.find(q => test(q.range)) ?? null;
    return p || t ? { p, t } : null;
  }

  let moveQueued = false, lastHit: string | null = null;
  function onMove(e: MouseEvent): void {
    if (!data || hidden() || moveQueued) return;
    moveQueued = true;
    requestAnimationFrame(() => {
      moveQueued = false;
      if (e.composedPath().includes(host)) return;
      const hit = hitAt(e.clientX, e.clientY);
      const key = hit && `${hit.p?.note.id ?? ''}|${hit.t ? hit.t.term.term + hit.t.range.startOffset : ''}`;
      if (key === lastHit) return;
      lastHit = key;
      document.documentElement.style.cursor = hit?.p ? 'pointer' : '';
      if (!hit) { hideTip(); return; }
      const parts: Node[] = [];
      if (hit.p) {
        const n = hit.p.note, replies = n.thread?.length ?? 0;
        parts.push(h('div', { class: 'k', style: `color:${kindOf(n).color}` }, label(n)), h('div', null, inline(n.title ?? '')),
          h('div', { style: 'color:#656d76;font-size:11px' }, `Click for details${replies ? ` · ${replies} message${replies === 1 ? '' : 's'}` : ''}`));
      }
      if (hit.t) {
        parts.push(h('div', { class: 'k', style: `color:${ACCENT};${hit.p ? 'margin-top:6px;padding-top:6px;border-top:1px solid #d8dee4' : ''}` }, hit.t.term.term),
          h('div', null, inline(hit.t.term.def)));
      }
      const target = hit.t ?? hit.p;
      if (target) showTip(rangeRef(target.range), parts);
    });
  }
  function onClick(e: MouseEvent): void {
    if (!data || hidden() || e.composedPath().includes(host)) return;
    if (!document.getSelection()?.isCollapsed) return;
    const hit = hitAt(e.clientX, e.clientY);
    if (hit?.p) {
      // A note on a link opens the card instead of following the link; Cmd/Ctrl/Shift-click still follows it.
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey) e.preventDefault();
      hideTip();
      openCard(hit.p);
    } else if (card && !hit) closeCard();
  }

  // ---------- painting ----------
  const KIND_NAMES = Object.keys(KINDS) as Kind[];
  function paint(): void {
    for (const k of [...KIND_NAMES, 'term', 'active']) CSS.highlights.delete(`at-${k}`);
    if (hidden() || !data) return;
    for (const k of KIND_NAMES) {
      const hl = new Highlight(...placed.filter(p => p.note.kind === k).map(p => p.range));
      hl.priority = 2;
      CSS.highlights.set(`at-${k}`, hl);
    }
    const th = new Highlight(...terms.map(t => t.range));
    th.priority = 1;
    CSS.highlights.set('at-term', th);
    if (activeHighlight) CSS.highlights.set('at-active', activeHighlight);
  }


  function buildMarks(): void {
    for (const m of marks) { m.ann?.remove(); m.proxy.remove(); }
    marks = [];
    for (const p of placed) {
      if (!p.note.decorate) continue;
      const proxy = h('div', { class: 'proxy' });
      marksLayer.append(proxy);
      marks.push({ p, proxy, ann: null, type: '', last: '' });
    }
  }

  // A box, circle, or underline drawn around the bounding box of text that wraps would cut
  // through the lines between, so wrapped text gets a bracket instead.
  function decorate(m: Mark, lines: number): void {
    const decoration = m.p.note.decorate ?? 'box';
    const type = lines > 1 ? 'bracket' : decoration;
    if (m.ann && m.type === type) return;
    m.ann?.remove();
    const config: RoughAnnotationConfig = { type, color: kindOf(m.p.note).color, padding: 4, strokeWidth: 2, animate: !m.ann, animationDuration: 600 };
    if (type === 'bracket') config.brackets = ['left', 'right'];
    m.ann = annotate(m.proxy, config);
    m.type = type;
  }

  function renderPins(): void {
    for (const el of pins) el.remove();
    pins = placed.filter(p => p.note.kind === 'step').map(p => {
      const done = isDone(p.note.id);
      const el = h('div', { class: `pin ${done ? 'done' : ''}`, title: p.note.title ?? '', onclick: () => openCard(p) }, done ? '✓' : String(p.note.step));
      el.dataset.id = p.note.id;
      marksLayer.append(el);
      return el;
    });
  }



  // An arrow between two notes that may be far apart: a bracket out of the left edge of A's line,
  // down the left margin, and into B's line, so it never crosses text.
  function marginArrow(a: Placed, b: Placed, text: string | undefined, color: string): SVGGElement | null {
    const ra = a.range.getClientRects()[0], rb = b.range.getClientRects()[0];
    if (!ra || !rb) return null;
    const col = a.range.startContainer.parentElement?.closest('article, main, section') ?? document.body;
    const gx = Math.max(col.getBoundingClientRect().left + scrollX - 28, scrollX + 8);
    const lineLeft = (p: Placed, r: DOMRect) => Math.min(blockOf(p.range)?.getBoundingClientRect().left ?? r.left, r.left) + scrollX;
    const ax = lineLeft(a, ra) - 6, ay = ra.top + scrollY + ra.height / 2;
    const bx = lineLeft(b, rb) - 8, by = rb.top + scrollY + rb.height / 2;
    const k = Math.min(10, Math.abs(by - ay) / 2), dir = by > ay ? 1 : -1;
    const g = svg('g');
    g.append(
      svg('path', { d: `M${ax},${ay} H${gx + k} Q${gx},${ay} ${gx},${ay + dir * k} V${by - dir * k} Q${gx},${by} ${gx + k},${by} H${bx}`,
        fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': '6 4' }),
      svg('polygon', { points: `${bx + 2},${by} ${bx - 8},${by - 5} ${bx - 8},${by + 5}`, fill: color }));
    if (text) {
      const ty = (ay + by) / 2;
      const t = svg('text', { x: gx - 8, y: ty, transform: `rotate(-90 ${gx - 8} ${ty})`, fill: color, 'font-size': 12, 'font-weight': 600,
        'font-family': 'system-ui, sans-serif', 'text-anchor': 'middle' });
      t.textContent = text;
      g.append(t);
    }
    return g;
  }

  function layout(): void {
    if (hidden() || !data) return;
    for (const m of marks) {
      const r = pageRect(m.p.range.getBoundingClientRect());
      const sig = [r.x, r.y, r.w, r.h].map(Math.round).join();
      if (sig === m.last) continue;
      m.last = sig;
      Object.assign(m.proxy.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      decorate(m, lineCount(m.p.range));
      if (r.w && r.h) m.ann?.show(); else m.ann?.hide();
    }
    arrowSvg.replaceChildren();
    const docW = document.documentElement.clientWidth + scrollX;
    const taken: { x: number; y: number }[] = [];
    for (const el of pins) {
      const p = placed.find(q => q.note.id === el.dataset.id);
      const first = p?.range.getClientRects()[0];
      if (!p || !first) { el.style.display = 'none'; continue; }
      el.style.display = '';
      // The pin sits in the left gutter of its text block (with no room there, in the right
      // margin), and moves aside for a pin already on the same line. Its arrow ends at the start
      // of the line, never inside the text; the highlight marks the exact words.
      const br = blockOf(p.range)?.getBoundingClientRect() ?? first;
      const left = br.left + scrollX - 44 >= scrollX + 4;
      const y = first.top + scrollY + first.height / 2 - 12;
      let x = left ? br.left + scrollX - 44 : Math.min(br.right + scrollX + 16, docW - 34);
      while (taken.some(t => Math.abs(t.y - y) < 24 && Math.abs(t.x - x) < 24)) x += left ? -28 : 28;
      taken.push({ x, y });
      Object.assign(el.style, { left: `${x}px`, top: `${y}px` });
      const edge = left ? br.left + scrollX : br.right + scrollX;
      arrowSvg.append(stepArrow({ x, y, w: 24, h: 24 }, { x: edge - 1, y: first.top + scrollY, w: 2, h: first.height }));
    }
    for (const link of data.links ?? []) {
      const a = placed.find(p => p.note.id === link.from), b = placed.find(p => p.note.id === link.to);
      const arrow = a && b ? marginArrow(a, b, link.label, kindOf(a.note).color) : null;
      if (arrow) arrowSvg.append(arrow);
    }
  }

  // ---------- toast ----------
  let toast: HTMLElement | null = null;
  function updateToast(): void {
    toast?.remove();
    toast = null;
    const unread = unreadNotes();
    const first = unread[0];
    if (!first) return;
    const p = placed.find(q => q.note.id === first.id);
    toast = h('div', { class: 'toast' },
      h('div', { class: 'k', style: `color:${ACCENT}` }, unread.length > 1 ? `Claude replied on ${unread.length} notes` : 'Claude replied'),
      h('div', { style: 'margin:2px 0 8px' }, inline(first.title ?? first.quote)),
      h('div', { class: 'row' },
        h('button', { class: 'b', onclick: () => { toast?.remove(); toast = null; } }, 'Later'),
        p && h('button', { class: 'b primary', onclick: () => { if (hidden()) setHidden(false); scrollToNote(p); } }, 'Open')));
    ui.append(toast);
  }

  // ---------- panel ----------
  const panel = h('div', { class: 'panel' });
  ui.append(panel);
  function scrollToNote(p: Placed): void {
    p.range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => openCard(p), 350);
  }

  function renderPanel(): void {
    panel.replaceChildren();
    panel.style.display = data ? '' : 'none';
    if (!data) return;
    const open = panelOpen() && !hidden();
    panel.classList.toggle('mini', !open);
    const unread = new Set(unreadNotes().map(n => n.id));
    panel.append(h('header', null,
      h('span', { class: 't', title: data.title ?? '' }, potatoIcon(), data.title ?? 'Anno Tater'),
      unread.size > 0 && h('span', { class: 'badge', title: "Notes with a reply you haven't opened" }, `${unread.size} new`),
      h('button', { title: 'Hide or show all markings (Alt+Shift+H)', onclick: () => setHidden(!hidden()) }, hidden() ? 'Show' : 'Hide'),
      !hidden() && h('button', { title: 'Collapse panel', onclick: () => { store.set('panel-open', !panelOpen()); renderPanel(); } }, panelOpen() ? '–' : '+')));
    if (!open) return;
    const groups: [Kind, string][] = [['step', 'Steps'], ['issue', 'Problems'], ['caution', 'Caution'], ['agree', 'Looks good'], ['info', 'Context']];
    for (const [kind, title] of groups) {
      const items = placed.filter(p => p.note.kind === kind).toSorted((a, b) => (a.note.step ?? 0) - (b.note.step ?? 0));
      if (!items.length) continue;
      panel.append(h('div', { class: 'sec' }, h('h4', null, title), items.map(p => {
        const done = kind === 'step' && isDone(p.note.id);
        return h('div', { class: `item ${unread.has(p.note.id) ? 'unread' : ''}`, onclick: () => scrollToNote(p) },
          kind === 'step'
            ? h('input', { type: 'checkbox', checked: done, onclick: (e: Event) => { e.stopPropagation(); toggleDone(p.note); } })
            : h('span', { class: 'dot', style: `background:${KINDS[kind].color}` }),
          h('span', { class: 'label', style: done ? 'text-decoration:line-through;color:#656d76' : '' }, inline(p.note.title ?? p.note.quote)),
          unread.has(p.note.id) && h('span', { class: 'badge' }, 'new'));
      })));
    }
    const asks = outbox().filter(m => m.kind === 'ask');
    if (asks.length) panel.append(h('div', { class: 'sec' }, h('h4', null, 'Your questions'), asks.map(m =>
      h('div', { class: 'item miss', title: m.quote ?? '' }, h('span', { class: 'dot', style: `background:${ACCENT}` }),
        h('span', null, m.text ?? '', h('br'), h('span', { class: 'status', style: 'font-size:11px' }, pendingLabel(m.id)))))));
    if (unplaced.length) panel.append(h('div', { class: 'sec' }, h('h4', null, `Couldn't place (${unplaced.length})`),
      unplaced.map(n => h('div', { class: 'item miss', title: n.quote }, h('span', { class: 'dot', style: 'background:#8c959f' }), inline(n.title ?? n.quote)))));
    panel.append(h('label', { class: 'opt' },
      h('input', { type: 'checkbox', checked: blockKeys(), onchange: (e: Event) => store.set('block-keys', (e.target as HTMLInputElement).checked) }),
      'Block site shortcuts'));
    const waiting = outbox().length;
    panel.append(h('div', { class: 'meta' }, `${placed.length} placed · ${terms.length} term marks · `,
      twoWay ? `${waiting} message${waiting === 1 ? '' : 's'} waiting · select text to ask` : 'one-way: install the helper to reply'));
  }

  function setHidden(on: boolean): void {
    store.set(pageKey('hidden'), on);
    marksLayer.classList.toggle('off', on);
    if (on) { closeCard(); hideTip(); hideAsk(); document.documentElement.style.cursor = ''; }
    paint(); renderPanel();
    if (!on) { for (const m of marks) m.last = ''; layout(); }
  }

  // ---------- anchoring + re-anchoring ----------
  const scopeRoot = () => (data?.scope && document.querySelector(data.scope)) || document.querySelector('main') || document.body;

  function render(): void {
    placed = []; unplaced = []; terms = [];
    if (data && document.body) {
      const idx = buildIndex(scopeRoot());
      for (const note of data.notes) {
        const a = anchor(idx, note);
        if (a) placed.push({ note, ...a }); else unplaced.push(note);
      }
      terms = findTerms(idx, data.glossary);
    }
    paint(); buildMarks(); renderPins(); renderPanel();
    marksLayer.classList.toggle('off', hidden());
    requestAnimationFrame(layout);
    const p = cardNoteId ? placed.find(q => q.note.id === cardNoteId) : null;
    if (p) openCard(p); else if (cardNoteId) closeCard();
    updateToast();
  }

  // Pages like GitHub swap out the nodes under a range after load; re-anchor when that happens.
  const broken = () => placed.some(p => !p.range.startContainer.isConnected || !p.range.endContainer.isConnected)
    || terms.some(t => !t.range.startContainer.isConnected);
  let moTimer = 0;
  const mo = new MutationObserver(() => {
    clearTimeout(moTimer);
    moTimer = window.setTimeout(() => { if (broken()) render(); else layout(); }, 250);
  });
  let scrollQueued = false;
  const onScroll = (e: Event) => {
    if (e.target === document || scrollQueued) return; // the marks layer already moves with the window
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; layout(); });
  };
  const onResize = () => { for (const m of marks) m.last = ''; layout(); };

  return {
    load(notes, loaded) {
      data = notes;
      twoWay = loaded.twoWay;
      state = loaded.state;
      pending = loaded.pending;
      sentSince = sentSince.filter(m => !pending.some(p => p.id === m.id));
      if (started) render();
    },
    setDelivered(ids) {
      delivered = new Set([...delivered, ...ids]);
      renderPanel();
      const p = cardNoteId ? placed.find(q => q.note.id === cardNoteId) : null;
      if (p) openCard(p);
    },
    setTwoWay(on) { twoWay = on; renderPanel(); const p = cardNoteId ? placed.find(q => q.note.id === cardNoteId) : null; if (p) openCard(p); },
    setHidden,
    isHidden: hidden,
    start() {
      if (dead || started) return;
      started = true;
      document.documentElement.append(host);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageSheet];
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
      const listeners: [string, EventListener, boolean][] = [
        ['mousemove', onMove as EventListener, true], ['click', onClick as EventListener, true], ['mouseup', onMouseUp as EventListener, true],
        ['scroll', onScroll, true], ['resize', onResize, false],
      ];
      for (const [t, fn, capture] of listeners) { addEventListener(t, fn, capture); cleanups.push(() => removeEventListener(t, fn, capture)); }
      cleanups.push(() => mo.disconnect());
      render();
    },
    destroy() {
      dead = true;
      for (const c of cleanups) c();
      closeCard(); hideTip(); hideAsk();
      for (const m of marks) m.ann?.remove();
      for (const k of [...KIND_NAMES, 'term', 'active']) CSS.highlights.delete(`at-${k}`);
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== pageSheet);
      host.remove();
      document.documentElement.style.cursor = '';
    },
  };
}
