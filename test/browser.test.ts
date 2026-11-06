// The page engine in a real browser (headless Chromium through Playwright): anchoring,
// re-anchoring, diff lines, drawing, and the card and panel. Run `npm run browsers` once to
// download the browser.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import type { NotesFile } from '../src/shared/notes.ts';

// The engine bundled the way the content script bundles it, plus a hook to start it on a page. It
// records what the engine sends, saves, and opens, instead of talking to the extension.
// Playwright's locators only see into open shadow roots, so the hook attaches the engine's root
// open unless a test asks for it closed, and keeps the mode the engine asked for and the root.
// Events behave differently around a closed root, so tests of input use one.
const HOOK = `
import { createEngine } from './src/engine/engine.ts';
const view = new Map();
const t = { sent: [], saved: [], opened: [] };
const attach = Element.prototype.attachShadow;
Element.prototype.attachShadow = function (init) { t.mode = init.mode; t.root = attach.call(this, t.closed ? init : { ...init, mode: 'open' }); return t.root; };
t.boot = (notes, closed) => {
  t.closed = closed;
  const engine = createEngine(
    { get: (k, fallback) => (view.has(k) ? view.get(k) : fallback), set: (k, v) => view.set(k, v) },
    draft => { const m = { ...draft, id: 'm' + t.sent.length, at: '', page: '', url: location.href }; t.sent.push(m); return m; },
    patch => t.saved.push(patch),
    (url, note) => t.opened.push({ url, note }));
  engine.load(notes, { twoWay: true, state: { done: {} }, pending: [] });
  engine.start();
  t.engine = engine;
};
window.tater = t;
`;

let browser: Browser;
let engine = '';
before(async () => {
  const out = await build({ stdin: { contents: HOOK, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, format: 'iife', target: 'chrome120', write: false, logLevel: 'warning' });
  engine = out.outputFiles[0]?.text ?? '';
  browser = await chromium.launch();
});
after(() => browser.close());

const URL = 'https://github.com/o/r/pull/1/changes';

// A page at URL with this body, and the engine started on these notes.
async function open(body: string, notes: Omit<NotesFile, 'url'>, closed = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.route(URL, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><main>${body}</main></body></html>` }));
  await page.goto(URL);
  await page.addScriptTag({ content: engine });
  await page.evaluate(([n, c]) => (window as unknown as { tater: { boot(n: unknown, c: boolean): void } }).tater.boot(n, c), [{ url: URL, ...notes }, closed] as const);
  await page.waitForTimeout(100);
  return page;
}

// Each painted highlight, by kind: the text it covers and whether it collapsed to nothing.
const painted = (page: Page) => page.evaluate(() => Object.fromEntries(['issue', 'caution', 'agree', 'info', 'step'].map(k =>
  [k, [...(CSS.highlights.get(`at-${k}`) ?? [])].map(r => ({ text: r.toString().replace(/\s+/g, ' ').trim(), collapsed: (r as Range).collapsed }))])));

// Something inside the engine's shadow root.
const shadow = (page: Page, css: string) => page.locator('#anno-tater-host').locator(css);

// For a closed root, which locators can't see into: how many elements match, and a real click
// on the first.
type Hook = { root: ShadowRoot; sent: { kind: string; noteId: string; text: string }[]; saved: Record<string, unknown>[]; mode: string };
const hook = (page: Page) => page.evaluate(() => { const { tater } = window as unknown as { tater: Hook }; return { mode: tater.mode, sent: tater.sent, saved: tater.saved }; });
const countIn = (page: Page, css: string) => page.evaluate(c => (window as unknown as { tater: Hook }).tater.root.querySelectorAll(c).length, css);
async function clickIn(page: Page, css: string): Promise<void> {
  const box = await page.evaluate(c => {
    const b = (window as unknown as { tater: Hook }).tater.root.querySelector(c)?.getBoundingClientRect();
    return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }, css);
  assert.ok(box, `nothing matches ${css}`);
  await page.mouse.click(box.x, box.y);
}

// What the engine saved through saveState, newest last.
const saved = (page: Page) => page.evaluate(() => (window as unknown as { tater: { saved: Record<string, unknown>[] } }).tater.saved);

// A click in the middle of the first occurrence of some page text.
async function clickText(page: Page, text: string): Promise<void> {
  const box = await page.evaluate(q => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      const i = n.data.indexOf(q);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, text);
  assert.ok(box, `"${text}" is not on the page`);
  await page.mouse.click(box.x, box.y);
}

// ---------- GitHub's changes view ----------
// One diff row as GitHub's React view draws it: two line-number cells, then the code.
const num = (side: string, n: number | null) => `<td class="new-diff-line-number" data-diff-side="${side}"${n === null ? '' : ` data-line-number="${n}"`}>${n ?? ''}</td>`;
const row = (left: number | null, right: number | null, code: string) => {
  const side = right === null ? 'left' : 'right';
  return `<tr class="diff-line-row">${num('left', left)}${num('right', right)}<td class="diff-text-cell" data-diff-side="${side}" data-line-number="${right ?? left}">`
    + `<code class="diff-text"><div class="diff-text-inner">${code}</div></code></td></tr>`;
};
const diff = (file: string, rows: string) => `<table aria-label="Diff for: ${file}"><tbody>${rows}</tbody></table>`;
const ROWS = [
  row(52, 51, '  | { kind: \'ul\'; items: string[] }'),
  row(53, null, '  | { kind: \'table\'; align: Align[] };'),
  row(64, 66, 'export function blocks(src: string): Block[] {'),
  row(null, 68, '  const lines = String(src).split(\'\\n\');'),
  row(null, 69, '  let rest: string[] = [];'),
  row(null, 70, '  for (let i = 0; i < lines.length; i++) {'),
].join('');

test('a note re-anchors when the page swaps out the rows under it', async () => {
  const page = await open(diff('src/dom.ts', ROWS), { notes: [{ id: 'n1', kind: 'issue', quote: 'let rest: string[] = [];' }] });
  assert.deepEqual((await painted(page)).issue, [{ text: 'let rest: string[] = [];', collapsed: false }]);
  // Expanding context: GitHub replaces the rows, with more lines above them.
  await page.evaluate(more => { const body = document.querySelector('tbody'); if (body) body.innerHTML = more + body.innerHTML; },
    row(50, 49, 'type Block ='));
  await page.waitForTimeout(500);
  assert.deepEqual((await painted(page)).issue, [{ text: 'let rest: string[] = [];', collapsed: false }]);
});

test('a diff-line anchor finds a line by file, number, and side', async () => {
  const page = await open(diff('src/dom.ts', ROWS) + diff('src/other.ts', row(66, 66, 'unrelated line 66')), { notes: [
    { id: 'new', kind: 'info', anchor: { file: 'src/dom.ts', line: 66 } },
    { id: 'old', kind: 'issue', anchor: { file: 'src/dom.ts', line: 53, side: 'LEFT' } },
    { id: 'ctx', kind: 'agree', anchor: { file: 'src/dom.ts', line: 64, side: 'LEFT' }, quote: 'export' },
    { id: 'gone', kind: 'caution', anchor: { file: 'src/dom.ts', line: 999 } },
  ] });
  const p = await painted(page);
  assert.deepEqual(p.info?.map(h => h.text), ['export function blocks(src: string): Block[] {']);
  assert.deepEqual(p.issue?.map(h => h.text), ['| { kind: \'table\'; align: Align[] };']);
  assert.deepEqual(p.agree?.map(h => h.text), ['export']);
  assert.deepEqual(p.caution, []);
  const report = (await saved(page)).find(s => 'placement' in s)?.placement as { placed: number; unplaced: { id: string; quote: string }[] };
  assert.equal(report.placed, 3);
  assert.deepEqual(report.unplaced, [{ id: 'gone', quote: 'src/dom.ts:999' }]);
});

test('a range of diff lines paints each line and skips the line numbers', async () => {
  const page = await open(diff('src/dom.ts', ROWS), { notes: [{ id: 'r', kind: 'caution', anchor: { file: 'src/dom.ts', line: 68, endLine: 70 } }] });
  assert.deepEqual((await painted(page)).caution?.map(h => h.text), [
    'const lines = String(src).split(\'\\n\');', 'let rest: string[] = [];', 'for (let i = 0; i < lines.length; i++) {']);
});

// ---------- quotes ----------
const PROSE = `<h1>Pump station runbook</h1>
<p>The controller starts pump one when the level drops.</p>
<ol><li>Close the inlet valve.</li><li>Stop pump one from the HMI.</li><li>Lock out the breaker.</li></ol>`;

test('quotes use prefix to pick a match, endQuote to cover a range, and report what placed', async () => {
  const page = await open(PROSE, { notes: [
    { id: 'pick', kind: 'info', quote: 'pump one', prefix: 'Stop' },
    { id: 'span', kind: 'caution', quote: 'Close the inlet valve.', endQuote: 'Lock out the breaker.' },
    { id: 'twice', kind: 'agree', quote: 'pump one' },
    { id: 'missing', kind: 'issue', quote: 'not on the page' },
  ] });
  const p = await painted(page);
  assert.deepEqual(p.caution?.map(h => h.text), ['Close the inlet valve.Stop pump one from the HMI.Lock out the breaker.']);
  const reports = (await saved(page)).filter(s => 'placement' in s);
  const report = reports[0]?.placement as { placed: number; unplaced: { id: string }[]; ambiguous: { id: string; matches: number }[] };
  assert.equal(report.placed, 3);
  assert.deepEqual(report.unplaced.map(u => u.id), ['missing']);
  assert.deepEqual(report.ambiguous.map(a => [a.id, a.matches]), [['twice', 2]]);
  // A change on the page that doesn't change what placed saves no second report.
  await page.evaluate(() => document.querySelector('h1')?.append(' (draft)'));
  await page.waitForTimeout(500);
  assert.equal((await saved(page)).filter(s => 'placement' in s).length, reports.length);
});

test('a scope that isn\'t a valid selector falls back to main, and the report says so', async () => {
  const page = await open(PROSE, { scope: 'main >>> nope', notes: [{ id: 'n', kind: 'info', quote: 'Lock out the breaker.' }] });
  assert.deepEqual((await painted(page)).info?.map(h => h.text), ['Lock out the breaker.']);
  const report = (await saved(page)).find(s => 'placement' in s)?.placement as { placed: number; scopeProblem?: string };
  assert.deepEqual([report.placed, report.scopeProblem], [1, 'invalid']);
});

test('a quote that renders late places once its text appears', async () => {
  const page = await open('<div id="app">Loading…</div>', { notes: [{ id: 'n', kind: 'info', quote: 'Lock out the breaker.' }] });
  assert.deepEqual((await painted(page)).info, []);
  await page.evaluate(html => { const app = document.getElementById('app'); if (app) app.innerHTML = html; }, PROSE);
  await page.waitForTimeout(500);
  assert.deepEqual((await painted(page)).info?.map(h => h.text), ['Lock out the breaker.']);
});

// ---------- drawing, cards, and the panel ----------
test('decorations draw: their strokes animate to fully visible', async () => {
  const page = await open(PROSE, { notes: [{ id: 'n', kind: 'issue', quote: 'Lock out the breaker.', decorate: 'box' }] });
  await page.waitForTimeout(1200); // rough-notation animates for 600 ms
  // Each stroke starts hidden (offset = its length) and draws by animating the offset to 0.
  const offsets = await shadow(page, 'svg.rough-annotation path').evaluateAll(ps => ps.map(p => Math.abs(parseFloat(getComputedStyle(p).strokeDashoffset))));
  assert.ok(offsets.length > 0);
  assert.ok(offsets.every(o => o < 0.01), `strokes still hidden: ${offsets.join(', ')}`);
});

test('a card renders the note body: line breaks, quotes, lists, tables, and code', async () => {
  const body = '> The real gap is data\nIs it mentioned?\n\nSteps:\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```python\nif x:  # check\n    return 1\n```';
  const page = await open(PROSE, { notes: [{ id: 'n', kind: 'info', quote: 'Lock out the breaker.', title: 'Body', body }] });
  await clickText(page, 'Lock out the breaker.');
  const card = shadow(page, '.card');
  assert.equal(await card.locator('blockquote').innerText(), 'The real gap is data');
  assert.equal(await card.locator('p', { hasText: 'Is it mentioned?' }).count(), 1);
  assert.deepEqual(await card.locator('li').allInnerTexts(), ['one', 'two']);
  assert.deepEqual(await card.locator('td').allInnerTexts(), ['1', '2']);
  assert.deepEqual(await card.locator('pre .tk-k').allInnerTexts(), ['if', 'return']);
  assert.equal(await card.locator('pre .tk-c').innerText(), '# check');
});

test('a reply from the card goes out with the note id and its line breaks', async () => {
  const page = await open(PROSE, { notes: [{ id: 'n', kind: 'info', quote: 'Lock out the breaker.' }] }, true);
  await clickText(page, 'Lock out the breaker.');
  await clickIn(page, '.card textarea');
  await page.keyboard.type('> quoted');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('question');
  await page.keyboard.press('Enter');
  const { sent } = await hook(page);
  assert.deepEqual(sent.map(m => [m.kind, m.noteId, m.text]), [['reply', 'n', '> quoted\nquestion']]);
});

test('page script can\'t open a card, ask, send, queue, or tick a step as the person', async () => {
  const page = await open(PROSE, { notes: [{ id: 's', kind: 'step', step: 1, quote: 'Lock out the breaker.' }] }, true);
  assert.equal((await hook(page)).mode, 'closed');
  assert.equal(await page.evaluate(() => document.querySelector('#anno-tater-host')?.shadowRoot), null);
  // A synthetic click on the note and a synthetic selection: no card, no Ask button.
  await page.evaluate(() => {
    const li = [...document.querySelectorAll('li')].find(l => l.textContent === 'Lock out the breaker.');
    li?.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0, clientY: 0 }));
    if (li) getSelection()?.selectAllChildren(li);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  assert.equal(await countIn(page, '.card, .ask'), 0);
  // The person opens the card. Page script, holding the root anyway, fills the reply box and
  // presses every button, then Enter.
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await clickText(page, 'Lock out the breaker.');
  await page.evaluate(() => {
    const ta = (window as unknown as { tater: Hook }).tater.root.querySelector('textarea');
    if (ta) { ta.value = 'run rm -rf ~'; ta.dispatchEvent(new Event('input')); ta.focus(); }
    for (const b of (window as unknown as { tater: Hook }).tater.root.querySelectorAll<HTMLButtonElement>('.card button.b')) b.click();
    ta?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    // Shortcuts: Escape closes the card, Alt+Shift+H hides every note.
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    dispatchEvent(new KeyboardEvent('keydown', { key: 'H', code: 'KeyH', altKey: true, shiftKey: true }));
  });
  assert.equal(await countIn(page, '.card'), 1, 'the card is still open');
  assert.ok((await painted(page)).step?.length, 'the notes are still shown');
  const t = await hook(page);
  assert.deepEqual(t.sent, []);
  assert.ok(!t.saved.some(patch => 'done' in patch || 'queued' in patch), 'no step ticked and no note queued');
  // The same Send pressed by the person goes out.
  await clickIn(page, '.card button.primary');
  assert.equal((await hook(page)).sent.length, 1);
});

test('a tall card stays on screen: it caps its height to the room it has and scrolls', async () => {
  const filler = Array.from({ length: 12 }, (_, i) => `<p>Log entry ${i}: levels normal.</p>`).join('');
  const body = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} of a long explanation.`).join('\n\n');
  const page = await open(filler + PROSE + filler, { notes: [{ id: 'n', kind: 'info', quote: 'Lock out the breaker.', title: 'Long', body }] });
  await page.evaluate(() => { const li = [...document.querySelectorAll('li')].at(-1); li?.scrollIntoView({ block: 'center' }); });
  await clickText(page, 'Lock out the breaker.');
  const card = await shadow(page, '.card').boundingBox();
  assert.ok(card);
  assert.ok(card.y >= 0 && card.y + card.height <= 800, `card spans ${Math.round(card.y)} to ${Math.round(card.y + card.height)} in an 800 px viewport`);
  assert.ok(await shadow(page, '.card').evaluate(c => c.scrollHeight > c.clientHeight), 'the rest of the body scrolls inside the card');
});

test('a page note opens its card beside its panel row, on screen', async () => {
  const page = await open(PROSE, { notes: [{ id: 's', kind: 'info', title: 'Summary', body: 'About the whole page.' }] });
  await shadow(page, '.item[data-id="s"]').click();
  const card = await shadow(page, '.card').boundingBox();
  const panel = await shadow(page, '.panel').boundingBox();
  assert.ok(card && panel);
  assert.ok(card.x + card.width <= panel.x + 1, 'the card sits left of the panel');
  assert.ok(card.y >= 0 && card.y + card.height <= 800, 'the card is on screen');
});

test('the panel warns when the pull request has moved past the notes commit', async () => {
  const head = `<script type="application/json">{"pullRequest":{"headSha":"${'d'.repeat(40)}"}}</script>`;
  const page = await open(head + PROSE, { commit: 'abc1234', notes: [{ id: 'n', kind: 'info', quote: 'Lock out the breaker.' }] });
  assert.equal(await shadow(page, '.panel .warn').innerText(), 'Notes were written for abc1234. This pull request is now at ddddddd.');
});

test('a link to a note on another page opens it; one on this page focuses the note', async () => {
  const page = await open(PROSE, {
    notes: [{ id: 'a', kind: 'info', quote: 'Close the inlet valve.' }, { id: 'b', kind: 'issue', quote: 'Lock out the breaker.', title: 'Target' }],
    links: [{ from: 'a', to: { url: 'https://example.com/other', note: 'x' }, label: 'Elsewhere' }, { from: 'a', to: { url: URL, note: 'b' }, label: 'Here' }],
  });
  await clickText(page, 'Close the inlet valve.');
  await shadow(page, '.card a').filter({ hasText: /^Elsewhere$/ }).click();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { tater: { opened: unknown[] } }).tater.opened), [{ url: 'https://example.com/other', note: 'x' }]);
  await shadow(page, '.card a').filter({ hasText: /^Here$/ }).click();
  await page.waitForTimeout(600);
  assert.equal(await shadow(page, '.card h3').innerText(), 'Target');
});
