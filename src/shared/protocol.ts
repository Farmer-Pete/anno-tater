// Messages between the extension and the helper, and the fixed names both sides need.
import type { NotesFile, Outgoing } from './notes.ts';

export const HOST_NAME = 'com.farmerpete.annotater';
// Fixed by the public key in manifest/chrome.json.
export const CHROME_ID = 'pnonheeknfhclnmokcollijaflmhppdc';
// Set in manifest/firefox.json.
export const FIREFOX_ID = 'anno-tater@farmerpete';

// A page with notes, as the index lists it.
export interface PageSummary {
  page: string; // pageKey(url)
  url: string;
  title?: string;
  rev: number; // newest modification time of the page's notes, state, and inbox
}

// What a page remembers across browsers: ticked steps and replies already read.
export interface PageState {
  done: Record<string, boolean>;
  seen?: string[]; // "<noteId>#<index>" of Claude's replies; absent until the page is first shown
}

export type ToHost =
  | { type: 'get'; page: string }
  | { type: 'send'; message: Outgoing }
  | { type: 'state'; page: string; state: Partial<PageState> };

export type FromHost =
  | { type: 'hello'; pages: PageSummary[]; delivered: string[] }
  | { type: 'pages'; pages: PageSummary[] }
  // pending: the page's messages Claude hasn't answered or acked yet, from the inbox
  | { type: 'page'; page: string; notes: NotesFile | null; state: PageState; pending: Outgoing[] }
  | { type: 'sent'; id: string }
  | { type: 'delivered'; ids: string[] }
  | { type: 'error'; message: string };
