// Signs dist/firefox through addons.mozilla.org as an unlisted add-on, so Firefox and Zen keep it
// installed across restarts. Writes dist/anno-tater-<version>.xpi.
//
// Needs an AMO API key (https://addons.mozilla.org/en-US/developers/addon/api/key/) in
// ~/.amo.token as {"issuer": "...", "secret": "..."}, or in AMO_JWT_ISSUER / AMO_JWT_SECRET.
// AMO refuses a version number it has seen before, so bump package.json's version first.
// API: https://mozilla.github.io/addons-server/topics/api/addons.html
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const API = 'https://addons.mozilla.org/api/v5/addons';
const manifest = JSON.parse(readFileSync('dist/firefox/manifest.json', 'utf8')) as {
  version: string;
  browser_specific_settings: { gecko: { id: string } };
};
const guid = manifest.browser_specific_settings.gecko.id;
const version = manifest.version;

function credentials(): { issuer: string; secret: string } {
  if (process.env.AMO_JWT_ISSUER && process.env.AMO_JWT_SECRET) return { issuer: process.env.AMO_JWT_ISSUER, secret: process.env.AMO_JWT_SECRET };
  const { issuer, secret } = JSON.parse(readFileSync(join(homedir(), '.amo.token'), 'utf8')) as { issuer?: string; secret?: string };
  if (!issuer || !secret || issuer.startsWith('PASTE')) throw new Error('~/.amo.token needs your AMO issuer and secret');
  return { issuer, secret };
}

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');

// A fresh token per request: AMO requires a unique jti and an expiry within 5 minutes.
function token(): string {
  const { issuer, secret } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, { ...init, headers: { Authorization: `JWT ${token()}`, ...init.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function until<T>(what: string, poll: () => Promise<T>, done: (v: T) => boolean, minutes = 15): Promise<T> {
  const end = Date.now() + minutes * 60_000;
  for (;;) {
    const v = await poll();
    if (done(v)) return v;
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 5000));
  }
}

interface Upload { uuid: string; processed: boolean; valid: boolean; validation: { messages?: { type: string; message: string; file?: string }[] } | null }
interface Version { file: { status: string; url: string } | null }

// 1. Zip the build. -X leaves out macOS extended attributes.
const zip = resolve('dist', `anno-tater-${version}.zip`);
rmSync(zip, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: 'dist/firefox' });

// 2. Upload it to the unlisted channel and wait for validation.
console.log(`uploading ${guid} ${version}`);
const form = new FormData();
form.append('upload', new Blob([readFileSync(zip)]), `anno-tater-${version}.zip`);
form.append('channel', 'unlisted');
const created = await api<Upload>('/upload/', { method: 'POST', body: form });
const upload = await until('validation', () => api<Upload>(`/upload/${created.uuid}/`), u => u.processed);
for (const m of upload.validation?.messages ?? []) console.log(`\n${m.type}: ${m.message}${m.file ? ` (${m.file})` : ''}`);
if (!upload.valid) throw new Error('AMO rejected the upload; see the messages above');

// 3. Submit it: creates the add-on the first time, a new version after that.
await api(`/addon/${encodeURIComponent(guid)}/`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ version: { upload: upload.uuid } }),
});

// 4. Wait for the signed file, then download it.
console.log('\nwaiting for the signature');
const signed = await until('signing', () => api<Version>(`/addon/${encodeURIComponent(guid)}/versions/${version}/`), v => v.file?.status === 'public');
const url = signed.file?.url ?? '';
const res = await fetch(url, { headers: { Authorization: `JWT ${token()}` } });
if (!res.ok) throw new Error(`download failed: ${res.status}`);
const out = resolve('dist', `anno-tater-${version}.xpi`);
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
rmSync(zip);
console.log(`\nsigned: ${out}`);
