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
    const row = cell.closest('tr');
    const text = row?.querySelector(`td.diff-text-cell[data-diff-side="${s}"]`) ?? row?.querySelector('td.diff-text-cell');
    if (text) return text.querySelector('.diff-text-inner') ?? text;
  }
  return null;
}
