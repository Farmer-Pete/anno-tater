import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decoder, encode, MAX_TO_BROWSER } from '../src/host/framing.ts';
import type { NotesFile, Outgoing } from '../src/shared/notes.ts';
import type { FromHost } from '../src/shared/protocol.ts';

const home = () => mkdtempSync(join(tmpdir(), 'anno-tater-'));
const tater = (dir: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/tater.ts', ...args], { env: { ...process.env, ANNO_TATER_HOME: dir }, encoding: 'utf8' });
const channelIn = (output: string) => /channel ([0-9a-f-]{36})/.exec(output)?.[1] ?? '';
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as NotesFile;

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
  match: 'example.com/page', url: 'https://example.com/page',
  notes: [{ id: 'n1', kind: 'issue', quote: 'some text', title: 'A problem' }],
};

// Writes a notes file to a fresh data folder and pushes it, returning the folder, the file, and its new channel.
function pushed(extra: Partial<NotesFile> = {}) {
  const dir = home();
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify({ ...notes, ...extra }));
  return { dir, file, channel: channelIn(tater(dir, 'push', file)) };
}

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

test('push creates a channel and writes it into the notes file, so the next push reuses it', () => {
  const { dir, file, channel } = pushed();
  assert.match(channel, /^[0-9a-f]{8}-/);
  assert.equal(readJson(file).channel, channel);
  assert.equal(channelIn(tater(dir, 'push', file)), channel);
  assert.throws(() => tater(dir, 'push', file, '--channel', 'not-a-channel'));
});

test('helper, CLI and inbox work end to end', async () => {
  const { dir, channel } = pushed();
  const h = host(dir);
  try {
    const hello = await h.waitFor('hello');
    assert.deepEqual(hello.type === 'hello' && [hello.pages[0]?.channel, hello.pages[0]?.match], [channel, notes.match]);

    h.send({ type: 'get', channel, match: notes.match });
    const got = await h.waitFor('notes');
    assert.equal(got.type === 'notes' && got.notes?.notes[0]?.id, 'n1');

    const message: Outgoing = { id: 'm1', at: '', page: notes.url ?? '', match: notes.match, channel, kind: 'reply', noteId: 'n1', text: 'why?' };
    h.send({ type: 'send', message });
    await h.waitFor('sent');

    // The agent picks it up: watch prints it and marks it delivered, which the helper reports.
    const line = JSON.parse(tater(dir, 'watch', '--channel', channel, '--once').trim()) as Outgoing;
    assert.deepEqual([line.id, line.text], ['m1', 'why?']);
    const delivered = await h.waitFor('delivered');
    assert.deepEqual(delivered.type === 'delivered' && delivered.ids, ['m1']);

    // The agent answers: the thread grows, the message is acked, and the helper announces the change.
    assert.match(tater(dir, 'reply', 'm1', 'because'), /answered on n1/);
    await h.waitFor('pages');
    h.send({ type: 'get', channel, match: notes.match });
    const after = await h.waitFor('notes');
    const page = after.type === 'notes' ? after.notes : null;
    assert.deepEqual(page?.notes[0]?.thread, [{ from: 'you', text: 'why?' }, { from: 'claude', text: 'because' }]);
    assert.deepEqual(page?.acked, ['m1']);
    assert.equal(tater(dir, 'watch', '--channel', channel, '--once').trim(), '');
  } finally {
    h.child.kill();
  }
});

test('two channels annotate one page without touching each other', () => {
  const { dir, channel: a } = pushed();
  const other = join(dir, 'other.json');
  writeFileSync(other, JSON.stringify({ ...notes, notes: [{ id: 'n1', kind: 'step', step: 1, quote: 'more text' }] }));
  const b = channelIn(tater(dir, 'push', other));
  assert.notEqual(a, b);
  const status = tater(dir, 'status');
  assert.ok(status.includes(`channel ${a}`) && status.includes(`channel ${b}`));
  assert.equal((status.match(/example\.com\/page \(1 notes\)/g) ?? []).length, 2);
});

test('a question about a selection becomes a new note in the channel it was sent to', () => {
  const { dir, channel } = pushed();
  const ask: Outgoing = { id: 'm2', at: '', page: '', match: notes.match, channel, kind: 'ask', noteId: null, quote: 'term', prefix: 'a ', suffix: ' here', text: 'what is this?' };
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  writeFileSync(join(dir, 'inbox', `${channel}.jsonl`), `${JSON.stringify(ask)}\n`);
  assert.match(tater(dir, 'reply', 'm2', 'a thing'), /added note q-m2/);
  assert.ok(tater(dir, 'status').includes('(2 notes)'));
  assert.equal(tater(dir, 'watch', '--channel', channel, '--once').trim(), '');
});

test('tater finds the extension address Firefox and Zen store in prefs.js', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'anno-tater-home-'));
  const zen = join(fakeHome, 'Library/Application Support/zen');
  mkdirSync(join(zen, 'Profiles', 'abc.Default'), { recursive: true });
  writeFileSync(join(zen, 'installs.ini'), '[X]\nDefault=Profiles/abc.Default\n');
  const uuids = JSON.stringify(JSON.stringify({ 'other@x': '1', 'anno-tater@farmerpete': 'uuid-123' }));
  writeFileSync(join(zen, 'Profiles', 'abc.Default', 'prefs.js'), `user_pref("extensions.webextensions.uuids", ${uuids});\n`);
  const script = "import('./src/host/browsers.ts').then(m => console.log(m.geckoBase('zen'), m.geckoBase('firefox')))";
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
  assert.equal(out.trim(), 'moz-extension://uuid-123 null');
});
