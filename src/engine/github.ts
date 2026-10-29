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
