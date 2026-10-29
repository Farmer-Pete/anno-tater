# Anno Tater

A browser extension (Chrome, Zen, Firefox Developer Edition) that draws an agent's notes on any web page, plus the agent side (`tater` CLI, native messaging helper, and Claude Code skill). Design and data flow: [docs/design.md](docs/design.md). Notes format: [skill/reference.md](skill/reference.md).

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
- `npm run browsers`: download headless Chromium once. `test/browser.test.ts` runs the page engine in it (anchoring, re-anchoring, diff lines, drawing, cards); `npm run check` needs it.
- `npm run build`: `dist/chrome`, `dist/firefox` and its unsigned `dist/anno-tater.xpi`, and `skill/bin`.
- `./install.sh`: build, then install the skill and helper on this machine.
- `npm run release`: publish GitHub release `v<version>` with the files `install.sh` downloads. Bump `package.json`'s version first.

Releasing publishes outside this machine: confirm with the person first.

## How it fits together

- A page's URL without scheme or fragment is the key (a `#/` or `#!/` route stays): `~/.local/share/anno-tater/data/<page>/` holds the page's `page.json` (notes), `state.json`, and `inbox.jsonl`, shared by every browser.
- Extensions can't read files. The helper (started by the browser over stdio) reads and writes the data folder and talks to the background. Without the helper, `tater open` carries notes to the extension's `open.html` in the URL fragment: one-way only.
- The extension runs only on sites the person allowed (`optional_host_permissions`, one Allow click per site); the background registers the content script for those origins.
- Text highlights use the CSS Custom Highlight API, so pages that re-render can't erase them. Everything else lives in one shadow root.

## Testing in a browser

- Chrome: load `dist/chrome` unpacked. The manifest `key` fixes the ID to `pnonheeknfhclnmokcollijaflmhppdc`.
- Zen or Firefox Developer Edition: set `xpinstall.signatures.required` to `false` in `about:config`, then open `dist/anno-tater.xpi`; or load `dist/firefox/manifest.json` as a temporary add-on from `about:debugging`. Regular Firefox ignores that setting, so it's unsupported. Zen reads helper manifests from Mozilla's folder and reports itself as Firefox.
- After a rebuild, reload the extension in each browser.
