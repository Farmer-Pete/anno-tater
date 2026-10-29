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

// What a page remembers across browsers: ticked steps, replies already read, and what it last placed.
export interface PageState {
  done: Record<string, boolean>;
  seen?: string[]; // "<noteId>#<index>" of Claude's replies; absent until the page is first shown
  placement?: Placement;
}

// How the notes anchored the last time a browser drew the page, for tater status.
export interface Placement {
  at: string; // when the page drew them (ISO time)
  notes: string; // anchorsKey of the notes the page drew
  placed: number;
  onPage: number; // notes without a quote
  unplaced: { id: string; quote: string }[];
  ambiguous: { id: string; quote: string; matches: number }[]; // placed on the best of several equal matches
  commit?: string; // the pull request's head commit as the page showed it
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
