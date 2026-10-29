// What the engine knows about GitHub pages.

// The head commit of the pull request on this page, from the JSON GitHub embeds for its React
// views (every pull request tab has "headSha"). Null on other sites.
export function headCommit(): string | null {
  if (location.hostname !== 'github.com') return null;
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    const sha = /"headSha":"([0-9a-f]{40})"/.exec(s.textContent ?? '')?.[1];
    if (sha) return sha;
  }
  return null;
}

// The text of one line of a pull request's diff, by file, line number, and side, as GitHub's
// changes view marks it: each file is a table labelled "Diff for: <path>", and each row's cells
// carry data-diff-side and data-line-number. A context line's old (LEFT) number is only on its
// line-number cell, so the row is found by any cell and the text cell taken from that row.
export function diffLine(file: string, line: number, side: 'LEFT' | 'RIGHT' = 'RIGHT'): Element | null {
  const table = [...document.querySelectorAll('table[aria-label^="Diff for: "]')].find(t => t.getAttribute('aria-label') === `Diff for: ${file}`);
  const s = side.toLowerCase();
  for (const cell of table?.querySelectorAll(`td[data-diff-side="${s}"][data-line-number="${line}"]`) ?? []) {
    const text = rowText(cell.closest('tr'), s);
    if (text) return text;
  }
  return null;
}

// Every line's text from one diff line through another, in page order. In the unified view that
// includes the other side's lines between them; in the split view, only this side's.
export function diffLines(file: string, from: number, to: number, side: 'LEFT' | 'RIGHT' = 'RIGHT'): Element[] {
  const first = diffLine(file, from, side), last = diffLine(file, to, side);
  if (!first || !last) return [];
  const out: Element[] = [];
  for (const row of first.closest('table')?.querySelectorAll('tr') ?? []) {
    const text = rowText(row, side.toLowerCase());
    if (text === first || (out.length && text)) out.push(text as Element);
    if (text === last && out.length) return out;
  }
  return [];
}

// A diff row's code: its one text cell (unified view), or the given side's (split view).
function rowText(row: Element | null, side: string): Element | null {
  const cells = [...row?.querySelectorAll('td.diff-text-cell') ?? []];
  const cell = cells.length > 1 ? cells.find(c => c.getAttribute('data-diff-side') === side) : cells[0];
  return cell ? cell.querySelector('.diff-text-inner') ?? cell : null;
}
