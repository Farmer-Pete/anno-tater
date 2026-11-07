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

// Page keys kept the scheme from layout 3 on. Rekeys this browser's copies of notes, and the
// state of those pages, once.
export async function migrateLocal(): Promise<void> {
  const { layout = 1 } = await ext.storage.local.get('layout');
  if ((layout as number) >= 3) return;
  const pages = await localPages();
  const all = await ext.storage.local.get(null);
  const rekeyed: Record<string, NotesFile> = {}, moved: Record<string, unknown> = {}, old: string[] = [];
  for (const [key, notes] of Object.entries(pages)) {
    const now = pageKey(notes.url);
    rekeyed[now] = notes;
    if (now === key) continue;
    if (stateKey(key) in all) moved[stateKey(now)] = all[stateKey(key)];
    old.push(stateKey(key));
  }
  await ext.storage.local.set({ pages: rekeyed, ...moved, layout: 3 });
  await ext.storage.local.remove(old);
}

export async function localState(page: string): Promise<PageState> {
  const stored = (await ext.storage.local.get(stateKey(page)))[stateKey(page)] as PageState | undefined;
  return stored ?? { done: {} };
}

export async function saveLocalState(page: string, patch: Partial<PageState>): Promise<void> {
  const now = await localState(page);
  await ext.storage.local.set({ [stateKey(page)]: mergeState(now, patch) });
}
