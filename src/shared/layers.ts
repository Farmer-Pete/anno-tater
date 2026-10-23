// Several channels can annotate one page. Each channel's notes file is a layer; the extension
// draws them merged. Note ids are namespaced by channel so two layers can both have "n1", and
// `origin` maps each merged id back to the channel and file that wrote it, so a reply goes there.
import type { NotesFile } from './notes.ts';

export interface Origin {
  channel: string;
  match: string;
  id: string; // the note's id in its own file
}

const layerId = (channel: string, id: string) => `${channel}/${id}`;

// layers are newest first (see pickLayers); the newest supplies the title, scope, and url.
export function mergeLayers(layers: NotesFile[]): { merged: NotesFile; origin: Map<string, Origin> } {
  const origin = new Map<string, Origin>();
  const newest = layers[0];
  const terms = new Set<string>();
  const merged: NotesFile = {
    match: newest?.match ?? '',
    url: newest?.url,
    title: layers.length > 1 ? layers.map(l => l.title ?? l.match).join(' + ') : newest?.title,
    scope: layers.find(l => l.scope)?.scope,
    notes: layers.flatMap(l => l.notes.map(n => {
      const id = layerId(l.channel ?? '', n.id);
      origin.set(id, { channel: l.channel ?? '', match: l.match, id: n.id });
      return { ...n, id };
    })),
    links: layers.flatMap(l => (l.links ?? []).map(k => ({ ...k, from: layerId(l.channel ?? '', k.from), to: layerId(l.channel ?? '', k.to) }))),
    // The same term defined twice keeps the newest layer's definition.
    glossary: layers.flatMap(l => l.glossary ?? []).filter(g => !terms.has(g.term) && Boolean(terms.add(g.term))),
    acked: [...new Set(layers.flatMap(l => l.acked ?? []))],
  };
  return { merged, origin };
}
