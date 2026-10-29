import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { anchorsKey, decodeFragment, encodeFragment, findQuote, isPageNote, norm, originPattern, pageKey, parseNotes, validate, whereText, type NotesFile } from '../src/shared/notes.ts';

const sample: NotesFile = {
  url: 'https://example.com/docs/page',
  notes: [
    { id: 'a', kind: 'issue', quote: 'the thing' },
    { id: 's1', kind: 'step', step: 1, quote: 'first', decorate: 'box' },
  ],
  links: [{ from: 'a', to: 's1' }],
  glossary: [{ term: 'NCA', def: 'network-config-analysis' }],
};

test('a well-formed notes file has no problems', () => {
  assert.deepEqual(validate(sample), []);
});

test('validation names each problem', () => {
  const problems = validate({
    url: 'not a url',
    notes: [{ id: 'a', kind: 'nope', quote: ' ' }, { id: 'a', kind: 'step', quote: 'x' }],
    links: [{ from: 'a', to: 'missing' }],
  });
  assert.ok(problems.includes('url must be the http(s) address of the page'));
  assert.ok(problems.some(p => p.startsWith('notes[0].kind')));
  assert.ok(problems.some(p => p.startsWith('notes[0].quote')));
  assert.ok(problems.some(p => p.startsWith('notes[1].step')));
  assert.ok(problems.includes('note ids repeat: a'));
  assert.ok(problems.includes('links[0] must join a note id to a note id, or to { url, note } on another page'));
});

test('a note without a quote is a valid note about the whole page', () => {
  assert.deepEqual(validate({ url: 'https://example.com/', notes: [{ id: 's', kind: 'info', title: 'Start here' }] }), []);
});

test('parseNotes reports bad JSON plainly', () => {
  assert.throws(() => parseNotes('{'), /not valid JSON/);
});

test('a page key ignores the scheme and the fragment, but keeps the query', () => {
  assert.equal(pageKey('https://example.com/docs/page#top'), 'example.com/docs/page');
  assert.equal(pageKey('http://example.com/docs/page'), 'example.com/docs/page');
  assert.equal(pageKey('https://example.com/a.md?plain=1'), 'example.com/a.md?plain=1');
});

test('a page key keeps a fragment route, minus any anchor after it', () => {
  assert.equal(pageKey('https://app.example.com/#/users'), 'app.example.com/#/users');
  assert.equal(pageKey('https://app.example.com/#!/users/7'), 'app.example.com/#!/users/7');
  assert.equal(pageKey('https://app.example.com/#/docs#install'), 'app.example.com/#/docs');
  assert.equal(pageKey('https://app.example.com/#/'), 'app.example.com/');
  assert.equal(pageKey('https://app.example.com/#!/'), 'app.example.com/');
});

test('originPattern covers http and https only', () => {
  assert.equal(originPattern('https://github.com/a/b?c'), 'https://github.com/*');
  assert.equal(originPattern('file:///tmp/x.html'), null);
  assert.equal(originPattern('not a url'), null);
});

test('findQuote prefers the hit whose context matches', () => {
  const text = norm('the cat sat. the dog sat. the cat ran.');
  const { hits, ambiguous } = findQuote(text, { quote: 'the cat', suffix: 'ran' });
  assert.equal(hits[0], text.lastIndexOf('the cat'));
  assert.equal(ambiguous, false);
  assert.equal(findQuote(text, { quote: 'the cat' }).ambiguous, true);
  assert.deepEqual(findQuote(text, { quote: 'absent' }).hits, []);
});

test('findQuote matches across whitespace differences', () => {
  assert.equal(findQuote(norm('a\n  b   c'), { quote: 'a b\tc' }).hits[0], 0);
});

test('notes survive the URL fragment round trip', async () => {
  const fragment = await encodeFragment(sample);
  assert.match(fragment, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeFragment(fragment), sample);
});

test('a tampered fragment is rejected', async () => {
  await assert.rejects(decodeFragment('not-gzip'));
});

test("the skill reference's example is a valid notes file", () => {
  const doc = readFileSync('skill/reference.md', 'utf8');
  const example = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? '';
  assert.deepEqual(validate(JSON.parse(example)), []);
});

test('anchorsKey changes with what anchoring reads, and only that', () => {
  const base = { scope: 'main', notes: [{ id: 'n1', kind: 'info' as const, quote: 'some text', title: 'A' }] };
  const key = anchorsKey(base);
  assert.equal(anchorsKey({ ...base, notes: [{ ...base.notes[0]!, title: 'B', body: 'more' }] }), key);
  assert.notEqual(anchorsKey({ ...base, notes: [{ ...base.notes[0]!, quote: 'other text' }] }), key);
  assert.notEqual(anchorsKey({ ...base, scope: 'article' }), key);
});

test('commit must look like a SHA', () => {
  const page = { url: 'https://github.com/o/r/pull/1', notes: [] };
  assert.deepEqual(validate({ ...page, commit: 'cbfda8b' }), []);
  assert.deepEqual(validate({ ...page, commit: 'main' }), ['commit must be a commit SHA (7 to 40 hex digits)']);
});

test('a link can point at a note on another page', () => {
  const page = { url: 'https://github.com/o/r/pull/1', notes: [{ id: 't6', kind: 'info', quote: 'x' }] };
  assert.deepEqual(validate({ ...page, links: [{ from: 't6', to: { url: 'https://github.com/o/r/pull/1/changes', note: 'f-type' } }] }), []);
  assert.deepEqual(validate({ ...page, links: [{ from: 't6', to: { url: 'ftp://x', note: 'f' } }] }),
    ['links[0] must join a note id to a note id, or to { url, note } on another page']);
});

// A pull request page with one note on the given diff-line anchor.
const onLine = (anchor: unknown) => ({ url: 'https://github.com/o/r/pull/1/changes', notes: [{ id: 'n1', kind: 'issue', anchor }] });

test('a diff-line anchor names a file, a line, and optionally a side', () => {
  assert.deepEqual(validate(onLine({ file: 'src/app.py', line: 552, side: 'LEFT' })), []);
  for (const bad of [{ file: 'a', line: 0 }, { file: '', line: 3 }, { file: 'a', line: 3, side: 'right' }, 'a:3']) {
    assert.deepEqual(validate(onLine(bad)), ['notes[0].anchor needs file, a line number, and optionally side ("LEFT" or "RIGHT")']);
  }
  const note = { id: 'n', kind: 'info' as const, anchor: { file: 'a.py', line: 7, side: 'LEFT' as const } };
  assert.equal(whereText(note), 'a.py:7 (old)');
  assert.equal(isPageNote(note), false);
});
