import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decoder, encode, MAX_TO_BROWSER } from '../src/host/framing.ts';
import { pageFile } from '../src/host/store.ts';
import type { NotesFile, Outgoing } from '../src/shared/notes.ts';
import type { FromHost } from '../src/shared/protocol.ts';

const home = () => mkdtempSync(join(tmpdir(), 'anno-tater-'));
const tater = (dir: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/tater.ts', ...args], { env: { ...process.env, ANNO_TATER_HOME: dir }, encoding: 'utf8' });

test('framing round-trips messages split across chunks', () => {
  const got: unknown[] = [];
  const feed = decoder(m => got.push(m));
  const bytes = Buffer.concat([encode({ a: 1 }), encode({ b: 'é' })]);
  for (let i = 0; i < bytes.length; i += 3) feed(bytes.subarray(i, i + 3));
  assert.deepEqual(got, [{ a: 1 }, { b: 'é' }]);
});

test('framing refuses messages over the browser limit', () => {
  assert.throws(() => encode('x'.repeat(MAX_TO_BROWSER)), /browser limit/);
});

const notes: NotesFile = {
  match: 'example.com/page', url: 'https://example.com/page', owner: 'tester',
  notes: [{ id: 'n1', kind: 'issue', quote: 'some text', title: 'A problem' }],
};

// Runs the helper as the browser would and collects what it writes back.
function host(dir: string) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/host/main.ts', 'chrome-extension://test/'], { env: { ...process.env, ANNO_TATER_HOME: dir } });
  const received: FromHost[] = [];
  child.stdout.on('data', decoder(m => received.push(m as FromHost)));
  const waitFor = async (type: FromHost['type']) => {
    for (let i = 0; i < 100; i++) {
      const hit = received.find(m => m.type === type);
      if (hit) { received.splice(received.indexOf(hit), 1); return hit; }
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error(`no ${type} message`);
  };
  return { child, waitFor, send: (m: unknown) => child.stdin.write(encode(m)) };
}

test('helper, CLI and inbox work end to end', async () => {
  const dir = home();
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify(notes));
  assert.match(tater(dir, 'push', file), /saved/);

  const h = host(dir);
  try {
    const hello = await h.waitFor('hello');
    assert.equal(hello.type === 'hello' && hello.pages[0]?.match, notes.match);

    h.send({ type: 'get', match: notes.match });
    const got = await h.waitFor('notes');
    assert.equal(got.type === 'notes' && got.notes?.notes[0]?.id, 'n1');

    const message: Outgoing = { id: 'm1', at: '', page: notes.url ?? '', match: notes.match, owner: 'tester', kind: 'reply', noteId: 'n1', text: 'why?' };
    h.send({ type: 'send', message });
    await h.waitFor('sent');

    // The agent picks it up: watch prints it and marks it delivered, which the helper reports.
    const line = JSON.parse(tater(dir, 'watch', '--owner', 'tester', '--once').trim()) as Outgoing;
    assert.deepEqual([line.id, line.text], ['m1', 'why?']);
    const delivered = await h.waitFor('delivered');
    assert.deepEqual(delivered.type === 'delivered' && delivered.ids, ['m1']);

    // The agent answers: the thread grows, the message is acked, and the helper announces the change.
    assert.match(tater(dir, 'reply', 'm1', 'because'), /answered on n1/);
    await h.waitFor('pages');
    h.send({ type: 'get', match: notes.match });
    const after = await h.waitFor('notes');
    const page = after.type === 'notes' ? after.notes : null;
    assert.deepEqual(page?.notes[0]?.thread, [{ from: 'you', text: 'why?' }, { from: 'claude', text: 'because' }]);
    assert.deepEqual(page?.acked, ['m1']);
    assert.equal(tater(dir, 'watch', '--once').trim(), '');
  } finally {
    h.child.kill();
  }
});

test('a question about a selection becomes a new note where it was asked', () => {
  const dir = home();
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify(notes));
  tater(dir, 'push', file);
  const ask: Outgoing = { id: 'm2', at: '', page: '', match: notes.match, owner: 'tester', kind: 'ask', noteId: null, quote: 'term', prefix: 'a ', suffix: ' here', text: 'what is this?' };
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  writeFileSync(join(dir, 'inbox', 'tester.jsonl'), `${JSON.stringify(ask)}\n`);
  assert.match(tater(dir, 'reply', 'm2', 'a thing'), /added note q-m2/);
  const saved = JSON.parse(readFileSync(pageFileIn(dir, notes.match), 'utf8')) as NotesFile;
  const added = saved.notes.find(n => n.id === 'q-m2');
  assert.deepEqual([added?.quote, added?.prefix, added?.suffix], ['term', 'a ', ' here']);
  assert.deepEqual(added?.thread, [{ from: 'you', text: 'what is this?' }, { from: 'claude', text: 'a thing' }]);
  assert.deepEqual(saved.acked, ['m2']);
});

// The store resolves its folder from ANNO_TATER_HOME when called, so point it at the test's folder.
function pageFileIn(dir: string, match: string): string {
  const before = process.env.ANNO_TATER_HOME;
  process.env.ANNO_TATER_HOME = dir;
  try { return pageFile(match); } finally { process.env.ANNO_TATER_HOME = before; }
}
