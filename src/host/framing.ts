// Native messaging framing: each message is a 4-byte little-endian length, then UTF-8 JSON.
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging

// Chrome refuses messages from the host larger than 1 MB. A page's reply carries its notes, its
// shared state, and its unanswered messages, so each gets a share, in UTF-8 bytes of compact
// JSON: tater refuses to save larger notes, and the helper refuses a message or a state change
// that would take the unanswered messages or the shared state past theirs. The placement report
// stays out of the reply (only tater status reads it), so it doesn't count.
export const MAX_TO_BROWSER = 1024 * 1024;
export const MAX_NOTES = MAX_TO_BROWSER / 2;
export const MAX_PENDING = MAX_TO_BROWSER / 4;
export const MAX_STATE = MAX_TO_BROWSER / 8;

export function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_TO_BROWSER) throw new Error(`message is ${body.length} bytes; the browser limit is ${MAX_TO_BROWSER}`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Feed it chunks as they arrive from stdin; it calls onMessage once per complete message, and
// onBad for a message that isn't a JSON object, which it drops.
export function decoder(onMessage: (message: unknown) => void, onBad: (e: Error) => void = () => {}): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (pending.length < 4 + size) return;
      const body = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      let message: unknown;
      try { message = JSON.parse(body.toString('utf8')); } catch (e) { onBad(e as Error); continue; }
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) onMessage(message);
      else onBad(new Error('not an object'));
    }
  };
}
