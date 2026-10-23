import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mergeLayers } from '../src/shared/layers.ts';
import { decodeFragment, encodeFragment, findQuote, norm, originPattern, parseNotes, pickLayers, validate, type NotesFile } from '../src/shared/notes.ts';

const sample: NotesFile = {
  match: 'example.com/docs/page',
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
    match: '',
    notes: [{ id: 'a', kind: 'nope', quote: ' ' }, { id: 'a', kind: 'step', quote: 'x' }],
    links: [{ from: 'a', to: 'missing' }],
  });
  assert.ok(problems.includes('match must be a non-empty part of the page URL'));
  assert.ok(problems.some(p => p.startsWith('notes[0].kind')));
  assert.ok(problems.some(p => p.startsWith('notes[0].quote')));
  assert.ok(problems.some(p => p.startsWith('notes[1].step')));
  assert.ok(problems.includes('note ids repeat: a'));
  assert.ok(problems.includes('links[0] must join two note ids'));
});

test('url must contain match', () => {
  assert.deepEqual(validate({ ...sample, url: 'https://other.org/' }), ['url must contain match']);
});

test('parseNotes reports bad JSON plainly', () => {
  assert.throws(() => parseNotes('{'), /not valid JSON/);
});

test('each channel contributes its most specific match, newest channel first', () => {
  const files = [
    { channel: 'a', match: 'example.com', rev: 1 }, { channel: 'a', match: 'example.com/docs', rev: 1 },
    { channel: 'b', match: 'example.com', rev: 5 }, { channel: 'c', match: 'other.org', rev: 9 },
  ];
  const layers = pickLayers(files, 'https://example.com/docs/page#top');
  assert.deepEqual(layers.map(l => [l.channel, l.match]), [['b', 'example.com'], ['a', 'example.com/docs']]);
  assert.deepEqual(pickLayers(files, 'http://nowhere.net/'), []);
});

test('merged layers keep note ids apart and remember where each note came from', () => {
  const a: NotesFile = { channel: 'A', match: 'x.com/p', title: 'Review', notes: [{ id: 'n1', kind: 'issue', quote: 'q' }],
    links: [{ from: 'n1', to: 'n1' }], glossary: [{ term: 'T', def: 'from A' }], acked: ['m1'] };
  const b: NotesFile = { channel: 'B', match: 'x.com', title: 'Steps', notes: [{ id: 'n1', kind: 'step', step: 1, quote: 'r' }],
    glossary: [{ term: 'T', def: 'from B' }], acked: ['m2'] };
  const { merged, origin } = mergeLayers([a, b]);
  assert.deepEqual(merged.notes.map(n => n.id), ['A/n1', 'B/n1']);
  assert.deepEqual(origin.get('B/n1'), { channel: 'B', match: 'x.com', id: 'n1' });
  assert.deepEqual(merged.links, [{ from: 'A/n1', to: 'A/n1' }]);
  assert.deepEqual(merged.glossary, [{ term: 'T', def: 'from A' }]);
  assert.deepEqual(merged.acked, ['m1', 'm2']);
  assert.equal(merged.title, 'Review + Steps');
  assert.deepEqual(validate(merged), []);
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
  const fragment = await encodeFragment(sample, sample.url ?? '');
  assert.match(fragment, /^[A-Za-z0-9_-]+$/);
  const back = await decodeFragment(fragment);
  assert.equal(back.target, sample.url);
  assert.deepEqual(back.notes, sample);
});

test('a tampered fragment is rejected', async () => {
  await assert.rejects(decodeFragment('not-gzip'));
});

test("the skill reference's example is a valid notes file", () => {
  const doc = readFileSync('skill/reference.md', 'utf8');
  const example = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? '';
  assert.deepEqual(validate(JSON.parse(example)), []);
});
