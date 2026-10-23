import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFragment, encodeFragment, findQuote, norm, originPattern, pageKey, parseNotes, validate, type NotesFile } from '../src/shared/notes.ts';

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
  assert.ok(problems.includes('links[0] must join two note ids'));
});

test('parseNotes reports bad JSON plainly', () => {
  assert.throws(() => parseNotes('{'), /not valid JSON/);
});

test('a page key ignores the scheme and the fragment, but keeps the query', () => {
  assert.equal(pageKey('https://example.com/docs/page#top'), 'example.com/docs/page');
  assert.equal(pageKey('http://example.com/docs/page'), 'example.com/docs/page');
  assert.equal(pageKey('https://example.com/a.md?plain=1'), 'example.com/a.md?plain=1');
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
