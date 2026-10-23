import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFragment, encodeFragment, findQuote, norm, originPattern, parseNotes, pickNotes, validate, type NotesFile } from '../src/shared/notes.ts';

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

test('the most specific match wins, ignoring scheme and fragment', () => {
  const files = [{ match: 'example.com' }, { match: 'example.com/docs' }, { match: 'other.org' }];
  assert.equal(pickNotes(files, 'https://example.com/docs/page#top')?.match, 'example.com/docs');
  assert.equal(pickNotes(files, 'http://nowhere.net/'), null);
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

test("the skill reference's example is a valid notes file", async () => {
  const { readFileSync } = await import('node:fs');
  const doc = readFileSync('plugin/skills/anno-tater/reference.md', 'utf8');
  const example = /```json\n([\s\S]*?)\n```/.exec(doc)?.[1] ?? '';
  assert.deepEqual(validate(JSON.parse(example)), []);
});
