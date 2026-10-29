import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocks } from '../src/engine/dom.ts';

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
    { kind: 'p', text: 'Ports seen:' },
    {
      kind: 'table',
      align: ['left', 'center', 'right'],
      head: ['Port', 'Proto', 'Note'],
      rows: [['502', '`tcp`', 'Modbus'], ['20000', 'udp', ''], ['47808', 'udp', 'BACnet']],
    },
    { kind: 'p', text: 'Done.' },
  ]);
});

test('table cells keep escaped pipes, and outer pipes are optional', () => {
  assert.deepEqual(blocks('a | b\n--- | ---\n`x \\| y` | z'), [
    { kind: 'table', align: [null, null], head: ['a', 'b'], rows: [['`x | y`', 'z']] },
  ]);
});

test('pipes without a matching rule row stay a paragraph', () => {
  assert.deepEqual(blocks('a | b\n| --- |'), [{ kind: 'p', text: 'a | b | --- |' }]);
});

test('paragraphs and lists still split on blank lines', () => {
  assert.deepEqual(blocks('One\ntwo\n\n- a\n- b'), [
    { kind: 'p', text: 'One two' },
    { kind: 'ul', items: ['a', 'b'] },
  ]);
});
