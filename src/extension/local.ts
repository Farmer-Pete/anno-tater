// Notes delivered without the helper (through the intake page), and page state without the
// helper, kept in this browser's extension storage by page key.
import { pageKey, type NotesFile } from '../shared/notes.ts';
import { mergeState, type PageState } from '../shared/protocol.ts';
import { ext } from './compat.ts';

export async function localPages(): Promise<Record<string, NotesFile>> {
  const { pages } = await ext.storage.local.get('pages');
  return (pages ?? {}) as Record<string, NotesFile>;
}

export async function saveLocalPage(notes: NotesFile): Promise<void> {
  await ext.storage.local.set({ pages: { ...(await localPages()), [pageKey(notes.url)]: notes } });
}

const stateKey = (page: string) => `state:${page}`;

export async function localState(page: string): Promise<PageState> {
  const stored = (await ext.storage.local.get(stateKey(page)))[stateKey(page)] as PageState | undefined;
  return stored ?? { done: {} };
}

export async function saveLocalState(page: string, patch: Partial<PageState>): Promise<void> {
  const now = await localState(page);
  await ext.storage.local.set({ [stateKey(page)]: mergeState(now, patch) });
}
