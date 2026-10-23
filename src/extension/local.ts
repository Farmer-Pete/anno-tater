// Notes delivered without the helper (through the intake page), kept in extension storage by match.
import type { NotesFile } from '../shared/notes.ts';
import { ext } from './compat.ts';

export async function localPages(): Promise<Record<string, NotesFile>> {
  const { pages } = await ext.storage.local.get('pages');
  return (pages ?? {}) as Record<string, NotesFile>;
}

export async function saveLocalPage(notes: NotesFile): Promise<void> {
  await ext.storage.local.set({ pages: { ...(await localPages()), [notes.match]: notes } });
}
