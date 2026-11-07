import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { nodePath } from '../src/host/install.ts';
import { decoder, encode, MAX_NOTES, MAX_PENDING, MAX_STATE, MAX_TO_BROWSER } from '../src/host/framing.ts';
import { anchorsKey, MAX_TEXT, pageKey, type NotesFile, type Outgoing } from '../src/shared/notes.ts';
import type { FromHost } from '../src/shared/protocol.ts';

const home = () => mkdtempSync(join(tmpdir(), 'anno-tater-'));
// Runs tater on a data folder, as no agent session unless one is given.
const taterAs = (session: string, dir: string, ...args: string[]) =>
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/tater.ts', ...args], { env: { ...process.env, ANNO_TATER_HOME: dir, CLAUDE_CODE_SESSION_ID: session }, encoding: 'utf8', stdio: 'pipe' });
const tater = (dir: string, ...args: string[]) => taterAs('', dir, ...args);

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

// What a list of messages takes in the page's reply, as the helper counts it.
const size = (ms: Outgoing[]) => Buffer.byteLength(JSON.stringify(ms), 'utf8');

// A frame around any bytes, which encode would never write.
const frame = (text: string) => {
  const body = Buffer.from(text, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};

test('framing drops a message that isn\'t a JSON object and reads the next one', () => {
  const got: unknown[] = [], bad: string[] = [];
  const feed = decoder(m => got.push(m), e => bad.push(e.message));
  feed(Buffer.concat([frame('{not json'), frame('null'), frame('[1]'), encode({ ok: true })]));
  assert.deepEqual(got, [{ ok: true }]);
  assert.equal(bad.length, 3);
});

const notes: NotesFile = {
  url: 'https://example.com/page',
  notes: [{ id: 'n1', kind: 'issue', quote: 'some text', title: 'A problem' }],
};
const page = pageKey(notes.url);

// Writes a notes file to a fresh data folder and pushes it.
function pushed() {
  const dir = home();
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify(notes));
  const out = tater(dir, 'push', file);
  return { dir, file, out };
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
  const get = async () => {
    child.stdin.write(encode({ type: 'get', page }));
    const m = await waitFor('page');
    return m.type === 'page' ? m : null;
  };
  return { child, waitFor, get, send: (m: unknown) => child.stdin.write(encode(m)) };
}

test('push says where replies arrive, and keeps threads the agent copy lacks', () => {
  const { dir, file, out } = pushed();
  assert.match(out, /replies: tater watch --page https:\/\/example\.com\/page/);
  assert.match(tater(dir, 'status'), /page: https:\/\/example\.com\/page \(1 notes\)/);
  tater(dir, 'push', file); // a second push of the same page replaces the first: one file per page
  assert.equal((tater(dir, 'status').match(/page: /g) ?? []).length, 1);
});

test('helper, CLI and inbox work end to end', async () => {
  const { dir } = pushed();
  const h = host(dir);
  try {
    const hello = await h.waitFor('hello');
    assert.deepEqual(hello.type === 'hello' && [hello.pages[0]?.page, hello.pages[0]?.url], [page, notes.url]);
    assert.equal((await h.get())?.notes?.notes[0]?.id, 'n1');

    const message: Outgoing = { id: 'm1', at: '', page, url: notes.url, kind: 'reply', noteId: 'n1', text: 'why?' };
    h.send({ type: 'send', message });
    await h.waitFor('sent');
    assert.deepEqual((await h.get())?.pending.map(m => m.id), ['m1']); // every browser sees it waiting

    // The agent picks it up: watch prints it and marks it delivered, which the helper reports.
    const line = JSON.parse(tater(dir, 'watch', '--page', notes.url, '--once').trim()) as Outgoing;
    assert.deepEqual([line.id, line.text], ['m1', 'why?']);
    const delivered = await h.waitFor('delivered');
    assert.deepEqual(delivered.type === 'delivered' && delivered.ids, ['m1']);

    // The agent answers: the thread grows, the message is acked, and nothing waits any more.
    assert.match(tater(dir, 'reply', 'm1', 'because'), /answered on n1/);
    await h.waitFor('pages');
    const after = await h.get();
    assert.deepEqual(after?.notes?.notes[0]?.thread, [{ from: 'you', text: 'why?' }, { from: 'claude', text: 'because' }]);
    assert.deepEqual(after?.pending, []);
    assert.equal(tater(dir, 'watch', '--page', notes.url, '--once').trim(), '');
  } finally {
    h.child.kill();
  }
});

test('the helper refuses messages that would make the page too big for the browser, and says which page failed', async () => {
  const { dir, file } = pushed();
  const h = host(dir);
  const message = (id: string, text: string): Outgoing => ({ id, at: '', page, url: notes.url, kind: 'reply', noteId: 'n1', text });
  try {
    await h.waitFor('hello');
    // Shapes the page never sends: a message filed under another page, and state with a stray field.
    h.send({ type: 'send', message: { ...message('elsewhere', 'hi'), page: 'example.com/other' } });
    assert.match(JSON.stringify(await h.waitFor('error')), /page key of url/);
    h.send({ type: 'state', page, state: { owner: 'page script' } });
    assert.match(JSON.stringify(await h.waitFor('error')), /unknown field owner/);
    // An error that quotes something huge is cut short, so the helper can still send it.
    h.child.stdin.write(frame(JSON.stringify({ type: 'state', page, state: { ['x'.repeat(MAX_TO_BROWSER)]: true } })));
    assert.ok(JSON.stringify(await h.waitFor('error')).length < 2000);
    h.send({ type: 'send', message: message('long', 'x'.repeat(MAX_TEXT + 1)) });
    assert.match(JSON.stringify(await h.waitFor('error')), /up to 10000 characters/);
    // Unanswered messages up to their share of the limit, counted in UTF-8 bytes (each é is two);
    // the next one is refused.
    const each = 'é'.repeat(MAX_TEXT);
    for (let i = 0, waiting = (await h.get())?.pending ?? []; size([...waiting, message(`m${i}`, each)]) <= MAX_PENDING; i++, waiting = (await h.get())?.pending ?? []) {
      h.send({ type: 'send', message: message(`m${i}`, each) });
      await h.waitFor('sent');
    }
    h.send({ type: 'send', message: message('one-too-many', each) });
    assert.match(JSON.stringify(await h.waitFor('error')), /too many unanswered messages/);
    assert.ok(encode(await h.get()).length < MAX_TO_BROWSER, 'the page still fits');
    // Shared state past its share is refused too.
    h.send({ type: 'state', page, state: { seen: Array.from({ length: MAX_STATE / 8 }, (_, i) => `n1#${i}`) } });
    assert.match(JSON.stringify(await h.waitFor('error')), /shared state/);
    // A notes file too big for the browser: the error names the page.
    writeFileSync(join(dir, 'data', readdirSync(join(dir, 'data'))[0] ?? '', 'page.json'), JSON.stringify({ ...notes, notes: [{ ...notes.notes[0], body: 'z'.repeat(MAX_TO_BROWSER) }] }));
    h.send({ type: 'get', page });
    const error = await h.waitFor('error');
    assert.equal(error.type === 'error' && error.page, page);
    // Frames the browser never sends: the helper drops them and keeps going.
    h.child.stdin.write(frame('nope'));
    assert.match(JSON.stringify(await h.waitFor('error')), /isn't a JSON object: Unexpected/);
    h.child.stdin.write(frame('null'));
    assert.match(JSON.stringify(await h.waitFor('error')), /isn't a JSON object: not an object/);
    writeFileSync(join(dir, 'data', readdirSync(join(dir, 'data'))[0] ?? '', 'page.json'), JSON.stringify(notes));
    assert.equal((await h.get())?.notes?.notes[0]?.id, 'n1');
  } finally {
    h.child.kill();
  }
  // tater refuses to save notes over their share: a push, or a reply that would grow them past it.
  writeFileSync(file, JSON.stringify({ ...notes, notes: [{ ...notes.notes[0], body: 'z'.repeat(MAX_NOTES) }] }));
  assert.throws(() => tater(dir, 'push', file), /at most 524288/);
  writeFileSync(file, JSON.stringify({ ...notes, notes: [{ ...notes.notes[0], body: 'z'.repeat(MAX_NOTES - 1000) }] }));
  tater(dir, 'push', file);
  const h2 = host(dir);
  try {
    await h2.waitFor('hello');
    h2.send({ type: 'send', message: message('q', 'why?') });
    await h2.waitFor('sent');
  } finally {
    h2.child.kill();
  }
  assert.throws(() => tater(dir, 'reply', 'q', 'w'.repeat(2000)), /at most 524288/);
});

test('the page\'s reply leaves out the placement report', async () => {
  const { dir } = pushed();
  const h = host(dir);
  try {
    await h.waitFor('hello');
    const placement = { at: '', notes: '', placed: 0, onPage: 0, unplaced: [{ id: 'n1', quote: 'some text' }], ambiguous: [] };
    h.send({ type: 'state', page, state: { done: { n1: true }, placement } });
    await h.waitFor('pages');
    assert.deepEqual((await h.get())?.state, { done: { n1: true } });
    assert.match(tater(dir, 'status', '--page', notes.url), /unplaced: n1/);
  } finally {
    h.child.kill();
  }
});

test('each page keeps its notes, state, and inbox in one folder', async () => {
  const { dir } = pushed();
  const h = host(dir);
  try {
    await h.waitFor('hello');
    h.send({ type: 'state', page, state: { done: { n1: true } } });
    h.send({ type: 'send', message: { id: 'm1', at: '', page, url: notes.url, kind: 'reply', noteId: 'n1', text: 'hi' } satisfies Outgoing });
    await h.waitFor('sent');
  } finally {
    h.child.kill();
  }
  const [folder, ...more] = readdirSync(join(dir, 'data'));
  assert.deepEqual(more, []);
  assert.deepEqual(readdirSync(join(dir, 'data', folder ?? '')).toSorted(), ['inbox.jsonl', 'page.json', 'state.json']);
  assert.equal(existsSync(join(dir, 'pages')), false);
});

// Starts tater watch and resolves with its first line of output.
function firstLine(dir: string, ...args: string[]): { line: Promise<string>; stop: () => void } {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/tater.ts', 'watch', ...args], { env: { ...process.env, ANNO_TATER_HOME: dir } });
  const line = new Promise<string>(resolve => { child.stdout.on('data', (b: Buffer) => resolve(b.toString().trim())); });
  return { line, stop: () => child.kill() };
}

test('a running watch prints a message as it arrives, for one page or every page', async () => {
  const { dir } = pushed();
  const one = firstLine(dir, '--page', notes.url), all = firstLine(dir, '--all');
  const h = host(dir);
  try {
    await h.waitFor('hello');
    await new Promise(r => setTimeout(r, 300)); // let both watchers start
    h.send({ type: 'send', message: { id: 'm9', at: '', page, url: notes.url, kind: 'reply', noteId: 'n1', text: 'live' } satisfies Outgoing });
    for (const w of [one, all]) assert.equal((JSON.parse(await w.line) as Outgoing).id, 'm9');
  } finally {
    h.child.kill(); one.stop(); all.stop();
  }
});

test('reply --note answers every message waiting on that note, in order', async () => {
  const { dir } = pushed();
  const h = host(dir);
  try {
    await h.waitFor('hello');
    for (const [id, text] of [['m1', 'first?'], ['m2', 'and second?']] as const) {
      h.send({ type: 'send', message: { id, at: '', page, url: notes.url, kind: 'reply', noteId: 'n1', text } satisfies Outgoing });
      await h.waitFor('sent');
    }
  } finally {
    h.child.kill();
  }
  assert.match(tater(dir, 'reply', '--note', 'n1', 'both answered'), /answered on n1 \(2 messages\)/);
  const [folder] = readdirSync(join(dir, 'data'));
  const saved = JSON.parse(readFileSync(join(dir, 'data', folder ?? '', 'page.json'), 'utf8')) as NotesFile;
  assert.deepEqual(saved.notes[0]?.thread, [{ from: 'you', text: 'first?' }, { from: 'you', text: 'and second?' }, { from: 'claude', text: 'both answered' }]);
  assert.equal(tater(dir, 'watch', '--page', notes.url, '--once').trim(), '');
  assert.throws(() => tater(dir, 'reply', '--note', 'n1', 'again'), /no message is waiting on note n1/);
});

test('one watch follows several pages and skips the rest', async () => {
  const { dir } = pushed();
  const other = { ...notes, url: 'https://example.com/other' }, third = { ...notes, url: 'https://example.com/third' };
  for (const [name, n] of [['other.json', other], ['third.json', third]] as const) {
    writeFileSync(join(dir, name), JSON.stringify(n));
    tater(dir, 'push', join(dir, name));
  }
  const w = firstLine(dir, '--page', third.url, '--page', other.url);
  const h = host(dir);
  try {
    await h.waitFor('hello');
    await new Promise(r => setTimeout(r, 300));
    const say = (id: string, url: string) => h.send({ type: 'send', message: { id, at: '', page: pageKey(url), url, kind: 'reply', noteId: 'n1', text: id } satisfies Outgoing });
    say('not-watched', notes.url);
    await h.waitFor('sent');
    say('watched', other.url);
    assert.equal((JSON.parse(await w.line) as Outgoing).id, 'watched');
  } finally {
    h.child.kill(); w.stop();
  }
  const once = tater(dir, 'watch', '--page', other.url, '--page', third.url, '--once');
  assert.deepEqual(once.trim().split('\n').map(l => (JSON.parse(l) as Outgoing).id), ['watched']);
});

// The message ids in watch output.
const ids = (out: string) => out.trim().split('\n').filter(Boolean).map(l => (JSON.parse(l) as Outgoing).id);

test('watch --skip done,undone acks ticked steps without printing them', async () => {
  const { dir } = pushed();
  const h = host(dir);
  try {
    await h.waitFor('hello');
    for (const [id, kind, text] of [['t1', 'done', null], ['t2', 'undone', null], ['r1', 'reply', 'why?']] as const) {
      h.send({ type: 'send', message: { id, at: '', page, url: notes.url, kind, noteId: 'n1', text } satisfies Outgoing });
      await h.waitFor('sent');
    }
  } finally {
    h.child.kill();
  }
  assert.deepEqual(ids(tater(dir, 'watch', '--page', notes.url, '--once', '--skip', 'done,undone')), ['r1']);
  assert.deepEqual(ids(tater(dir, 'watch', '--page', notes.url, '--once')), ['r1']); // the ticks were acked, the reply still waits
  assert.throws(() => tater(dir, 'watch', '--page', notes.url, '--once', '--skip', 'reply'), /--skip takes done and undone only/);
});

test('a push over notes another session wrote needs --force', () => {
  const { dir, file } = pushed();
  taterAs('aaaaaaaa-1111', dir, 'push', file); // notes with no owner yet: any session may take them
  assert.match(taterAs('aaaaaaaa-1111', dir, 'status'), /\(1 notes, session aaaaaaaa \(this one\)\)/);
  assert.throws(() => taterAs('bbbbbbbb-2222', dir, 'push', file), /another agent session \(aaaaaaaa\) wrote the notes for https:\/\/example\.com\/page; pass --force/);
  taterAs('bbbbbbbb-2222', dir, 'push', file, '--force');
  assert.match(tater(dir, 'status'), /\(1 notes, session bbbbbbbb\)/);
  tater(dir, 'push', file); // without a session id, nothing to compare
});

test('shared glossary files merge into the page glossary, and a term the page defines wins', () => {
  const dir = home();
  writeFileSync(join(dir, 'shared.json'), JSON.stringify([{ term: 'NCA', def: 'shared NCA' }, { term: 'PLC', def: 'shared PLC' }]));
  writeFileSync(join(dir, 'other-notes.json'), JSON.stringify({ url: 'https://example.com/b', notes: [], glossary: [{ term: 'HMI', def: 'from a notes file' }] }));
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify({ ...notes, glossaryFiles: ['shared.json', './other-notes.json'], glossary: [{ term: 'PLC', def: 'this page' }] }));
  assert.match(tater(dir, 'check', file), /ok: 1 notes and 3 terms/);
  tater(dir, 'push', file);
  const [folder] = readdirSync(join(dir, 'data'));
  const saved = JSON.parse(readFileSync(join(dir, 'data', folder ?? '', 'page.json'), 'utf8')) as NotesFile;
  assert.deepEqual(saved.glossary, [{ term: 'NCA', def: 'shared NCA' }, { term: 'HMI', def: 'from a notes file' }, { term: 'PLC', def: 'this page' }]);
  writeFileSync(file, JSON.stringify({ ...notes, glossaryFiles: ['missing.json'] }));
  assert.throws(() => tater(dir, 'check', file), /glossary file missing\.json: ENOENT/);
  writeFileSync(join(dir, 'bad.json'), JSON.stringify([{ term: 'X' }]));
  writeFileSync(file, JSON.stringify({ ...notes, glossaryFiles: ['bad.json'] }));
  assert.throws(() => tater(dir, 'check', file), /bad\.json\[0\] needs term and def/);
});

test('status --page prints what the page last placed, and says when the notes moved on', async () => {
  const { dir, file } = pushed();
  assert.match(tater(dir, 'status', '--page', notes.url), /placement: not reported yet/);
  const h = host(dir);
  try {
    await h.waitFor('hello');
    const placement = { at: '2026-10-29T12:00:00.000Z', notes: anchorsKey(notes), placed: 16, onPage: 1,
      unplaced: [{ id: 'c3', quote: 'switch_id = int(raw[:2]) * 100' }], ambiguous: [{ id: 't5', quote: 'More than one match', matches: 2 }] };
    h.send({ type: 'state', page, state: { placement } });
    // The page's reply leaves the report out, so read it where tater does.
    await eventually(async () => placementIn(dir)?.placed, 16);
  } finally {
    h.child.kill();
  }
  const out = tater(dir, 'status', '--page', notes.url);
  assert.match(out, /placed: 16, plus 1 about the whole page/);
  assert.match(out, /unplaced: c3 "switch_id = int\(raw\[:2\]\) \* 100"/);
  assert.match(out, /ambiguous: t5 "More than one match" \(2 matches; add prefix or suffix\)/);
  assert.doesNotMatch(out, /stale/);
  writeFileSync(file, JSON.stringify({ ...notes, notes: [{ ...notes.notes[0], quote: 'new text' }] }));
  tater(dir, 'push', file);
  assert.match(tater(dir, 'status', '--page', notes.url), /stale: the notes changed/);
});

test('status --page says when the pull request moved past the notes commit', async () => {
  const dir = home();
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify({ ...notes, commit: 'abc1234' }));
  tater(dir, 'push', file);
  const h = host(dir);
  try {
    await h.waitFor('hello');
    const placement = { at: '', notes: '', placed: 1, onPage: 0, unplaced: [], ambiguous: [], commit: 'def5678'.padEnd(40, '0') };
    h.send({ type: 'state', page, state: { placement } });
    await eventually(async () => placementIn(dir)?.commit, placement.commit);
  } finally {
    h.child.kill();
  }
  assert.match(tater(dir, 'status', '--page', notes.url), /commit: the notes are for abc1234, but the page shows def5678/);
});

test('mark --posted records the comment, and a later push keeps it', () => {
  const { dir, file } = pushed();
  const saved = () => JSON.parse(readFileSync(join(dir, 'data', readdirSync(join(dir, 'data'))[0] ?? '', 'page.json'), 'utf8')) as NotesFile;
  const comment = 'https://github.com/o/r/pull/1#discussion_r1';
  assert.match(tater(dir, 'mark', 'n1', '--posted', comment), /marked n1 posted on https:\/\/example\.com\/page/);
  tater(dir, 'push', file); // the agent's copy has no posted field
  assert.equal(saved().notes[0]?.posted, comment);
  assert.throws(() => tater(dir, 'mark', 'n1', '--posted', 'not a url'), /notes\[0\]\.posted must be the http\(s\) address/);
  assert.throws(() => tater(dir, 'mark', 'nope', '--posted', comment), /no note nope/);
});

test('export --github-review turns queued notes into a pending review', async () => {
  const dir = home();
  const url = 'https://github.com/o/r/pull/7/changes';
  const file = join(dir, 'notes.json');
  writeFileSync(file, JSON.stringify({ url, commit: 'a'.repeat(40), notes: [
    { id: 'l1', kind: 'issue', anchor: { file: 'src/app.py', line: 552 }, title: 'Off by one', body: 'Use `<=`.' },
    { id: 'l2', kind: 'caution', anchor: { file: 'src/app.py', line: 10, endLine: 14, side: 'LEFT' }, title: 'Dead block' },
    { id: 'q1', kind: 'info', quote: 'the summary', title: 'Not on a line' },
    { id: 'p1', kind: 'info', anchor: { file: 'a', line: 1 }, title: 'Already posted', posted: 'https://github.com/o/r/pull/7#discussion_r1' },
    { id: 'n1', kind: 'info', anchor: { file: 'a', line: 2 }, title: 'Not queued' },
  ] }));
  tater(dir, 'push', file);
  assert.throws(() => tater(dir, 'export', '--github-review', '--page', url), /no notes are queued/);
  const h = host(dir);
  try {
    await h.waitFor('hello');
    h.send({ type: 'state', page: pageKey(url), state: { queued: { l1: true, l2: true, q1: true, p1: true } } });
    h.send({ type: 'state', page: pageKey(url), state: { queued: { n1: false } } }); // merges, doesn't replace
    await eventually(async () => {
      h.child.stdin.write(encode({ type: 'get', page: pageKey(url) }));
      const m = await h.waitFor('page');
      return m.type === 'page' ? m.state.queued : null;
    }, { l1: true, l2: true, q1: true, p1: true, n1: false });
  } finally {
    h.child.kill();
  }
  assert.deepEqual(JSON.parse(tater(dir, 'export', '--github-review', '--page', url)), {
    commit_id: 'a'.repeat(40),
    body: '> the summary\n\n**Not on a line**',
    comments: [
      { path: 'src/app.py', line: 552, side: 'RIGHT', body: '**Off by one**\n\nUse `<=`.' },
      { path: 'src/app.py', line: 14, side: 'LEFT', start_line: 10, start_side: 'LEFT', body: '**Dead block**' },
    ],
  });
});

// Retries until read() returns want, for changes that arrive through file watching.
// The placement report the one page in a data folder last saved.
function placementIn(dir: string): { placed?: number; commit?: string } | undefined {
  const [folder] = readdirSync(join(dir, 'data'));
  try { return (JSON.parse(readFileSync(join(dir, 'data', folder ?? '', 'state.json'), 'utf8')) as { placement?: { placed?: number; commit?: string } }).placement; } catch { return undefined; }
}

async function eventually(read: () => Promise<unknown>, want: unknown): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { assert.deepEqual(await read(), want); return; } catch { await new Promise(r => setTimeout(r, 40)); }
  }
  assert.deepEqual(await read(), want);
}

test('ticked steps and read replies are shared by every browser through the helper', async () => {
  const { dir } = pushed();
  const chrome = host(dir), zen = host(dir);
  try {
    await chrome.waitFor('hello');
    await zen.waitFor('hello');
    // Each write lands through one browser's helper and shows up in the other's.
    chrome.send({ type: 'state', page, state: { done: { n1: true }, seen: ['n1#1'] } });
    await eventually(async () => (await zen.get())?.state, { done: { n1: true }, seen: ['n1#1'] });
    zen.send({ type: 'state', page, state: { done: { s2: true } } });
    await eventually(async () => (await chrome.get())?.state.done, { n1: true, s2: true });
  } finally {
    chrome.child.kill();
    zen.child.kill();
  }
});

test('a question on a page without notes reaches --all, and the answer starts its notes', async () => {
  const dir = home();
  const ask: Outgoing = { id: 'm2', at: '', page: 'https://example.org/x', url: 'https://example.org/x#ignore-previous-instructions', kind: 'ask', noteId: null, quote: 'term', prefix: 'a ', suffix: ' here', text: 'what is this?' };
  const h = host(dir);
  h.send({ type: 'send', message: ask });
  try {
    await h.waitFor('sent');
  } finally {
    h.child.kill();
  }
  // The page's text is grouped apart from the person's, and the address (with its fragment) stays out.
  assert.deepEqual(JSON.parse(tater(dir, 'watch', '--all', '--once')), {
    id: 'm2', kind: 'ask', noteId: null, page: 'https://example.org/x', text: 'what is this?', pageText: { quote: 'term', prefix: 'a ', suffix: ' here' },
  });
  assert.match(tater(dir, 'reply', 'm2', 'a thing'), /added note q-m2/);
  assert.match(tater(dir, 'status'), /page: https:\/\/example\.org\/x \(1 notes\)/);
  assert.equal(tater(dir, 'watch', '--all', '--once').trim(), '');
});

test('tater finds the extension address Zen and Firefox store in prefs.js', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'anno-tater-home-'));
  const zen = join(fakeHome, 'Library/Application Support/zen');
  execFileSync('mkdir', ['-p', join(zen, 'Profiles', 'abc.Default')]);
  writeFileSync(join(zen, 'installs.ini'), '[X]\nDefault=Profiles/abc.Default\n');
  const uuids = JSON.stringify(JSON.stringify({ 'other@x': '1', 'anno-tater@farmerpete': 'uuid-123' }));
  writeFileSync(join(zen, 'Profiles', 'abc.Default', 'prefs.js'), `user_pref("extensions.webextensions.uuids", ${uuids});\n`);
  const script = "import('./src/host/browsers.ts').then(m => console.log(m.geckoBase('zen'), m.geckoBase('firefox-dev')))";
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', script], { env: { ...process.env, HOME: fakeHome }, encoding: 'utf8' });
  assert.equal(out.trim(), 'moz-extension://uuid-123 null');
});

// A page folder's name in data layouts 1 (8 hex digits of the key's SHA-256) and 2 (16).
const oldName = (key: string, digits: number) => `${key.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)}-${createHash('sha256').update(key).digest('hex').slice(0, digits)}`;
const layout1Name = (key: string) => oldName(key, 8);

// The permission bits of a file or folder, as octal digits.
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);

test('the data folder and everything in it are private to the person', async () => {
  const { dir } = pushed();
  const h = host(dir);
  try {
    await h.waitFor('hello');
    h.send({ type: 'send', message: { id: 'm1', at: '', page, url: notes.url, kind: 'reply', noteId: 'n1', text: 'hi' } satisfies Outgoing });
    await h.waitFor('sent');
    h.send({ type: 'state', page, state: { done: { n1: true } } });
    await h.waitFor('pages');
  } finally {
    h.child.kill();
  }
  tater(dir, 'watch', '--page', notes.url, '--once'); // writes delivered.jsonl
  const [folder] = readdirSync(join(dir, 'data'));
  const pageFolder = join(dir, 'data', folder ?? '');
  assert.deepEqual([dir, join(dir, 'data'), pageFolder].map(mode), ['700', '700', '700']);
  assert.deepEqual(['page.json', 'inbox.jsonl', 'state.json'].map(f => mode(join(pageFolder, f))), ['600', '600', '600']);
  assert.equal(mode(join(dir, 'delivered.jsonl')), '600');
});

test('tater moves an older data folder to the current layout', () => {
  const dir = home();
  // Layout 1: 8 hex digits, and whatever modes the umask gave.
  const withNotes = join(dir, 'data', layout1Name('example.com/page')); // 0.1.2's key had no scheme
  const asked = join(dir, 'data', layout1Name('example.org/q'));
  mkdirSync(withNotes, { recursive: true });
  mkdirSync(asked, { recursive: true });
  writeFileSync(join(withNotes, 'page.json'), JSON.stringify({ ...notes, notes: [{ ...notes.notes[0], thread: [{ from: 'you', text: 'kept' }] }] }));
  writeFileSync(join(asked, 'inbox.jsonl'), `${JSON.stringify({ id: 'q1', at: '', page: 'example.org/q', url: 'https://example.org/q', kind: 'ask', noteId: null, quote: 'x', text: 'what?' })}\n`);
  // A folder with only state can't say its page, and a stray file in another isn't the folder's.
  const stateOnly = join(dir, 'data', layout1Name('example.org/s'));
  mkdirSync(stateOnly);
  writeFileSync(join(stateOnly, 'state.json'), '{"done":{}}');
  writeFileSync(join(withNotes, 'state.json'), '{"done":{"n1":true}}');
  writeFileSync(join(dir, 'data', '.DS_Store'), '');
  chmodSync(join(withNotes, 'page.json'), 0o644);
  chmodSync(join(asked, 'inbox.jsonl'), 0o644);
  chmodSync(dir, 0o755);
  assert.match(tater(dir, 'status'), /page: https:\/\/example\.com\/page \(1 notes\)/);
  const folders = readdirSync(join(dir, 'data')).filter(f => f !== '.DS_Store').toSorted();
  assert.deepEqual(folders.filter(f => !/-[0-9a-f]{16}$/.test(f)), [layout1Name('example.org/s')]);
  assert.equal(folders.length, 3);
  const moved = (prefix: string) => join(dir, 'data', folders.find(f => f.startsWith(prefix) && /-[0-9a-f]{16}$/.test(f)) ?? '');
  assert.deepEqual([moved('https-example.com'), join(moved('https-example.com'), 'state.json'), join(moved('https-example.org-q'), 'inbox.jsonl')].map(mode), ['700', '600', '600']);
  // The message's page is rekeyed with the scheme, so it matches its notes once the agent answers.
  assert.equal((JSON.parse(readFileSync(join(moved('https-example.org-q'), 'inbox.jsonl'), 'utf8')) as Outgoing).page, 'https://example.org/q');
  assert.match(tater(dir, 'watch', '--all', '--once'), /"id":"q1"/);
  assert.equal(tater(dir, 'reply', 'q1', 'an answer').trim(), 'added note q-q1');
  assert.deepEqual([mode(dir), mode(join(dir, 'data', folders.find(f => f.startsWith('https-example.com')) ?? '', 'page.json'))], ['700', '600']);
  assert.equal(readFileSync(join(dir, 'layout'), 'utf8').trim(), '3');
  // An older helper or tater still running writes under the old name again: the next start moves
  // it in, keeping messages the new folder lacks and the newer notes.
  const stale = join(dir, 'data', layout1Name('example.org/q'));
  mkdirSync(stale);
  writeFileSync(join(stale, 'inbox.jsonl'), `${JSON.stringify({ id: 'q2', at: '', page: 'example.org/q', url: 'https://example.org/q', kind: 'ask', noteId: null, quote: 'y', text: 'and?' })}\n`);
  assert.match(tater(dir, 'watch', '--all', '--once'), /"id":"q2"/);
  assert.ok(!existsSync(stale));
});

test('the launcher names node by an absolute path, never from a relative PATH entry', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'anno-tater-path-'));
  writeFileSync(join(cwd, 'node'), '');
  const here = process.cwd();
  process.chdir(cwd);
  try {
    assert.equal(nodePath(['.', cwd].join(':')), join(cwd, 'node'));
    assert.equal(nodePath('.:node_modules/.bin'), process.execPath);
  } finally {
    process.chdir(here);
  }
});

test('layout 2 folders, keyed without the scheme, move to the scheme-keyed name once', () => {
  const dir = home();
  const folder = join(dir, 'data', oldName('example.com/page', 16));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'page.json'), JSON.stringify(notes));
  writeFileSync(join(folder, 'inbox.jsonl'), `${JSON.stringify({ id: 'r1', at: '', page: 'example.com/page', url: notes.url, kind: 'reply', noteId: 'n1', text: 'hi' })}\n`);
  writeFileSync(join(dir, 'layout'), '2\n');
  assert.match(tater(dir, 'status'), /page: https:\/\/example\.com\/page \(1 notes, 1 waiting/);
  assert.deepEqual(readdirSync(join(dir, 'data')).map(f => f.replace(/-[0-9a-f]{16}$/, '')), ['https-example.com-page']);
  assert.match(tater(dir, 'reply', '--note', 'n1', 'hello'), /answered on n1/);
});

test('an http page and its https twin keep separate notes, and --page without a scheme means https', () => {
  const dir = home();
  for (const [scheme, title] of [['https', 'secure'], ['http', 'plain']]) {
    writeFileSync(join(dir, 'n.json'), JSON.stringify({ ...notes, url: `${scheme}://example.com/page`, title }));
    tater(dir, 'push', join(dir, 'n.json'));
  }
  assert.equal(readdirSync(join(dir, 'data')).length, 2);
  assert.match(tater(dir, 'status', '--page', 'example.com/page'), /page: https:\/\/example\.com\/page \(1 notes\)/);
  assert.doesNotMatch(tater(dir, 'status', '--page', 'example.com/page'), /http:\/\//);
  assert.match(tater(dir, 'status', '--page', 'http://example.com/page'), /page: http:\/\/example\.com\/page/);
});

// A reply as tater 0.1.2 stored it: the page key had no scheme.
const oldReply = (id: string, scheme: string) => JSON.stringify({ id, at: '', page: 'example.com/page', url: `${scheme}://example.com/page`, kind: 'reply', noteId: 'n1', text: id });

test('migration splits an inbox an http page and its https twin shared, keeps lines it can\'t read, and catches late old folders', () => {
  const dir = home();
  const shared = join(dir, 'data', oldName('example.com/page', 8));
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'page.json'), JSON.stringify(notes));
  writeFileSync(join(shared, 'inbox.jsonl'), `${oldReply('s1', 'https')}\n${oldReply('p1', 'http')}\n{"id":"broken\n${oldReply('s2', 'https')}\n`);
  // Push runs the migration and doesn't read inboxes (readers still stop at a broken line).
  writeFileSync(join(dir, 'n.json'), JSON.stringify(notes));
  tater(dir, 'push', join(dir, 'n.json'));
  assert.equal(readFileSync(join(dir, 'layout'), 'utf8').trim(), '3'); // the broken line didn't stop it
  const inbox = (prefix: string) => readFileSync(join(dir, 'data', readdirSync(join(dir, 'data')).find(f => f.startsWith(prefix)) ?? '', 'inbox.jsonl'), 'utf8');
  assert.deepEqual(inbox('https-').split('\n').filter(Boolean).map(l => { try { return (JSON.parse(l) as Outgoing).id; } catch { return l; } }), ['s1', '{"id":"broken', 's2']);
  assert.deepEqual(inbox('http-').split('\n').filter(Boolean).map(l => [(JSON.parse(l) as Outgoing).id, (JSON.parse(l) as Outgoing).page]), [['p1', 'http://example.com/page']]);
  // Code that wrote layout 2 (no scheme, 16 hex digits) still running after layout 3 was recorded.
  // (status reads every inbox, so the broken line goes first.)
  const httpsInbox = join(dir, 'data', readdirSync(join(dir, 'data')).find(f => f.startsWith('https-')) ?? '', 'inbox.jsonl');
  writeFileSync(httpsInbox, readFileSync(httpsInbox, 'utf8').split('\n').filter(l => !l.includes('broken')).join('\n'));
  const late = join(dir, 'data', oldName('example.org/late', 16));
  mkdirSync(late);
  writeFileSync(join(late, 'page.json'), JSON.stringify({ ...notes, url: 'https://example.org/late' }));
  assert.match(tater(dir, 'status', '--page', 'https://example.org/late'), /\(1 notes\)/);
  assert.ok(!existsSync(late));
});

test('an answer starts its notes at the address of the message, even when older code wrote its page', () => {
  const dir = home();
  const folder = join(dir, 'data', `https-example.org-z-${'0'.repeat(16)}`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'inbox.jsonl'), `${JSON.stringify({ id: 'z1', at: '', page: 'example.org/z', url: 'https://example.org/z', kind: 'ask', noteId: null, quote: 'q', text: 'what?' })}\n`);
  writeFileSync(join(dir, 'layout'), '3\n'); // already migrated, so nothing rekeys the message first
  assert.match(tater(dir, 'reply', 'z1', 'this'), /added note q-z1/);
  assert.match(tater(dir, 'status', '--page', 'https://example.org/z'), /page: https:\/\/example\.org\/z \(1 notes\)/);
});

test('migration keeps a message on the page it was stored under, even when its address now keys another page', () => {
  // Before page keys kept #/ routes, a reply sent from https://host/#/jobs/1 was stored under the
  // bare page, beside that page's notes.
  const dir = home();
  const folder = join(dir, 'data', oldName('example.com/', 8));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'page.json'), JSON.stringify({ ...notes, url: 'https://example.com/' }));
  const reply = { id: 'r1', at: '', page: 'example.com/', url: 'https://example.com/#/jobs/1', kind: 'reply', noteId: 'n1', text: 'hi' };
  const { page: _, ...noPage } = { ...reply, id: 'r2', url: 'https://example.com/' }; // a record with no page at all keys by its address
  writeFileSync(join(folder, 'inbox.jsonl'), `${JSON.stringify(reply)}\n${JSON.stringify(noPage)}\n`);
  // And a question on a page without notes, from the same time.
  const asked = join(dir, 'data', oldName('example.org/', 8));
  mkdirSync(asked);
  writeFileSync(join(asked, 'inbox.jsonl'), `${JSON.stringify({ ...reply, id: 'q1', kind: 'ask', noteId: null, quote: 'q', page: 'example.org/', url: 'https://example.org/#/x' })}\n`);
  const status = tater(dir, 'status');
  assert.match(status, /page: https:\/\/example\.com\/ \(1 notes, 2 waiting/);
  assert.ok(!readdirSync(join(dir, 'data')).some(f => f.includes('undefined')));
  assert.match(status, /questions from pages without notes: 1/);
  assert.match(tater(dir, 'reply', 'q1', 'there'), /added note q-q1/);
  assert.match(tater(dir, 'status'), /page: https:\/\/example\.org\/ \(1 notes\)/);
});
