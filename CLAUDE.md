# Anno Tater

A Chrome and Firefox extension that draws an agent's notes on any web page, plus the agent side (`tater` CLI, native messaging helper, and Claude Code skill). Design and data flow: [docs/design.md](docs/design.md). Notes format: [skill/reference.md](skill/reference.md).

## Layout

| Path | What |
| --- | --- |
| `src/shared` | Notes format, validation, page keys, quote matching, helper protocol. Runs in Node and the browser. |
| `src/engine` | Draws notes on a page: anchoring, highlights, cards, panel, arrows. |
| `src/extension` | Background, content script, popup, and the intake page for no-helper mode. |
| `src/host` | The native messaging helper, the data folder, browser knowledge, and `tater install`. |
| `src/cli/tater.ts` | The agent's CLI. |
| `skill/` | The Claude Code skill. `npm run build` bundles tater and the helper into `skill/bin`. |
| `manifest/` | The extension manifest: `base.json` plus per-browser overrides. |

## Commands

- `npm run check`: types, lint, dead code, duplication, suppression scan, tests, build. The pre-commit hook runs it; turn the hook on with `git config core.hooksPath .githooks`.
- `npm run build`: `dist/chrome`, `dist/firefox`, and `skill/bin`.
- `./install.sh`: build, then install the skill and helper on this machine.
- `npm run sign:firefox`: sign `dist/firefox` on addons.mozilla.org as unlisted. Needs `~/.amo.token`. AMO refuses a version number twice, so bump `package.json` first.
- `npm run release`: publish GitHub release `v<version>` with the files `install.sh` downloads. Needs the signed build.

Signing and releasing publish outside this machine: confirm with the person first.

## How it fits together

- A page's URL without scheme or fragment is the key: `pages/`, `state/`, and `inbox/` in `~/.local/share/anno-tater/` each hold one file per page, shared by every browser.
- Extensions can't read files. The helper (started by the browser over stdio) reads and writes the data folder and talks to the background. Without the helper, `tater open` carries notes to the extension's `open.html` in the URL fragment: one-way only.
- The extension runs only on sites the person allowed (`optional_host_permissions`, one Allow click per site); the background registers the content script for those origins.
- Text highlights use the CSS Custom Highlight API, so pages that re-render can't erase them. Everything else lives in one shadow root.

## Testing in a browser

- Chrome: load `dist/chrome` unpacked. The manifest `key` fixes the ID to `pnonheeknfhclnmokcollijaflmhppdc`.
- Firefox or Zen: `about:debugging`, Load Temporary Add-on, `dist/firefox/manifest.json`. Zen reads helper manifests from Mozilla's folder and reports itself as Firefox.
- After a rebuild, reload the extension in each browser.
