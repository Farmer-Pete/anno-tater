// Messages between the extension and the helper, and the fixed names both sides need.
import type { NotesFile, Outgoing } from './notes.ts';

export const HOST_NAME = 'com.farmerpete.annotater';
// Fixed by the public key in manifest/chrome.json.
export const CHROME_ID = 'pnonheeknfhclnmokcollijaflmhppdc';
// Set in manifest/firefox.json.
export const FIREFOX_ID = 'anno-tater@farmerpete';

export interface PageSummary {
  match: string;
  url?: string;
  title?: string;
  owner?: string;
  rev: number; // changes whenever the file does
}

export type ToHost =
  | { type: 'get'; match: string }
  | { type: 'send'; message: Outgoing };

export type FromHost =
  | { type: 'hello'; version: string; pages: PageSummary[]; delivered: string[] }
  | { type: 'pages'; pages: PageSummary[] }
  | { type: 'notes'; match: string; notes: NotesFile | null }
  | { type: 'sent'; id: string }
  | { type: 'delivered'; ids: string[] }
  | { type: 'error'; message: string };
