// Native messaging framing: each message is a 4-byte little-endian length, then UTF-8 JSON.
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging

// Chrome refuses messages from the host larger than 1 MB.
export const MAX_TO_BROWSER = 1024 * 1024;

export function encode(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_TO_BROWSER) throw new Error(`message is ${body.length} bytes; the browser limit is ${MAX_TO_BROWSER}`);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

// Feed it chunks as they arrive from stdin; it calls onMessage once per complete message.
export function decoder(onMessage: (message: unknown) => void): (chunk: Buffer) => void {
  let pending = Buffer.alloc(0);
  return chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const size = pending.readUInt32LE(0);
      if (pending.length < 4 + size) return;
      const body = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      onMessage(JSON.parse(body.toString('utf8')));
    }
  };
}
