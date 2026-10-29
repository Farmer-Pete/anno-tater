import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocks, tokens } from '../src/engine/dom.ts';

test('a markdown table becomes a table block, with alignment and ragged rows evened out', () => {
  const src = [
    'Ports seen:',
    '| Port | Proto | Note |',
    '| :--- | :-: | ---: |',
    '| 502 | `tcp` | Modbus |',
    '| 20000 | udp |',
    '| 47808 | udp | BACnet | extra |',
    'Done.',
  ].join('\n');
  assert.deepEqual(blocks(src), [
    { kind: 'p', lines: ['Ports seen:'] },
    {
      kind: 'table',
      align: ['left', 'center', 'right'],
      head: ['Port', 'Proto', 'Note'],
      rows: [['502', '`tcp`', 'Modbus'], ['20000', 'udp', ''], ['47808', 'udp', 'BACnet']],
    },
    { kind: 'p', lines: ['Done.'] },
  ]);
});

test('table cells keep escaped pipes, and outer pipes are optional', () => {
  assert.deepEqual(blocks('a | b\n--- | ---\n`x \\| y` | z'), [
    { kind: 'table', align: [null, null], head: ['a', 'b'], rows: [['`x | y`', 'z']] },
  ]);
});

test('pipes without a matching rule row stay a paragraph', () => {
  assert.deepEqual(blocks('a | b\n| --- |'), [{ kind: 'p', lines: ['a | b', '| --- |'] }]);
});

test('paragraphs and lists split on blank lines, and a paragraph keeps its line breaks', () => {
  assert.deepEqual(blocks('One\ntwo\n\n- a\n- b'), [
    { kind: 'p', lines: ['One', 'two'] },
    { kind: 'ul', items: ['a', 'b'] },
  ]);
});

test('a fenced code block keeps its blank lines and language, between paragraphs', () => {
  assert.deepEqual(blocks('Before\n```Python\ndef f():\n\n    return 1\n```\nAfter'), [
    { kind: 'p', lines: ['Before'] },
    { kind: 'code', lang: 'python', text: 'def f():\n\n    return 1' },
    { kind: 'p', lines: ['After'] },
  ]);
});

test('an unclosed fence runs to the end, and markdown inside a fence stays code', () => {
  assert.deepEqual(blocks('```\n- not a list\n| a | b |\n| - | - |'), [
    { kind: 'code', lang: '', text: '- not a list\n| a | b |\n| - | - |' },
  ]);
});

test('the highlighter marks comments, strings, numbers, and keywords, and leaves a # inside a string alone', () => {
  assert.deepEqual(tokens('python', 'if x == "a#b":  # check\n    return 0x1F'), [
    ['k', 'if'], [null, ' x == '], ['s', '"a#b"'], [null, ':  '], ['c', '# check'], [null, '\n    '], ['k', 'return'], [null, ' '], ['n', '0x1F'],
  ]);
  assert.deepEqual(tokens('js', "let s = 'it\\'s'; // done"), [['k', 'let'], [null, ' s = '], ['s', "'it\\'s'"], [null, '; '], ['c', '// done']]);
  assert.deepEqual(tokens('', 'if 1'), [[null, 'if 1']]);
});

test('a diff block marks added, removed, and hunk lines', () => {
  assert.deepEqual(tokens('diff', '@@ -1 +1 @@\n-old\n+new\n same'), [['hunk', '@@ -1 +1 @@'], ['del', '-old'], ['add', '+new'], [null, ' same']]);
});

test('a quote is its own block, parsed again inside, and runs of lines keep their kind', () => {
  assert.deepEqual(blocks('> The real gap is data\nIs the data gap mentioned? And does it matter?'), [
    { kind: 'quote', blocks: [{ kind: 'p', lines: ['The real gap is data'] }] },
    { kind: 'p', lines: ['Is the data gap mentioned? And does it matter?'] },
  ]);
  assert.deepEqual(blocks('> - one\n>\n> two\nSteps:\n- a\n- b'), [
    { kind: 'quote', blocks: [{ kind: 'ul', items: ['one'] }, { kind: 'p', lines: ['two'] }] },
    { kind: 'p', lines: ['Steps:'] },
    { kind: 'ul', items: ['a', 'b'] },
  ]);
});
