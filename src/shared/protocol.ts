// Messages between the extension and the helper, and the fixed names both sides need.
import type { NotesFile, Outgoing } from './notes.ts';

export const HOST_NAME = 'com.farmerpete.annotater';
// Fixed by the public key in manifest/chrome.json.
export const CHROME_ID = 'pnonheeknfhclnmokcollijaflmhppdc';
// Set in manifest/firefox.json.
export const FIREFOX_ID = 'anno-tater@farmerpete';

// One notes file: a channel's layer for the pages its match covers.
export interface PageSummary {
  channel: string;
  match: string;
  url?: string;
  title?: string;
  rev: number; // the file's modification time; changes whenever the file does
}

export type ToHost =
  | { type: 'get'; channel: string; match: string }
  | { type: 'send'; message: Outgoing };

export type FromHost =
  | { type: 'hello'; pages: PageSummary[]; delivered: string[] }
  | { type: 'pages'; pages: PageSummary[] }
  | { type: 'notes'; channel: string; match: string; notes: NotesFile | null }
  | { type: 'sent'; id: string }
  | { type: 'delivered'; ids: string[] }
  | { type: 'error'; message: string };
