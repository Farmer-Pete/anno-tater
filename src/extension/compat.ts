import type { NotesFile, Outgoing } from '../shared/notes.ts';

// Chrome's MV3 `chrome.*` APIs return promises; Firefox's promise-based APIs live on `browser`.
// Using `browser` where it exists covers both with one set of types.
export const ext: typeof chrome = (globalThis as { browser?: typeof chrome }).browser ?? chrome;

// Messages between the content script and the background, over a runtime port named "page".

export type FromPage =
  | { type: 'hello'; url: string }
  | { type: 'send'; message: Outgoing };

export type ToPage =
  | { type: 'notes'; notes: NotesFile | null; twoWay: boolean; delivered: string[] }
  | { type: 'delivered'; ids: string[] }
  | { type: 'twoWay'; on: boolean }
  | { type: 'toggle-hidden' };

// Requests from the popup and the intake page to the background.
export type Request =
  | { type: 'popup' }
  | { type: 'activate'; tabId: number }
  | { type: 'toggle-hidden'; tabId: number }
  | { type: 'granted' };

export interface PopupState {
  helper: 'connected' | 'missing' | 'unknown';
  helperError: string;
  needsAccess: { origin: string; host: string; titles: string[] }[]; // one row per site, with its pages
  tabNotes: number | null; // notes on the active tab, or null when none are loaded
}
