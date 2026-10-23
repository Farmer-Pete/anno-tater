# Anno Tater

Lets a coding agent such as Claude Code mark up any web page for you, and lets you answer from the page.

The agent writes one small JSON file per page. The extension draws it:

- **Highlights that explain.** Red for problems, amber for caution, green for agreement, blue for context. Hover for the gist, click for the details.
- **Steps.** Numbered pins with a checklist, for manual work such as a test the agent can't do itself.
- **Definitions.** Glossary terms get a dotted underline and a hover definition everywhere they appear.
- **Boxes, brackets, and arrows** that follow the text as the page reflows.
- **Replies.** Answer a note, ask about any text you select, or mark a step done. The message reaches the agent that wrote the notes, and the page tells you when it has been picked up and when the agent replies.
- **Hide all** with one click or Alt+Shift+H.

Highlights use the CSS Custom Highlight API, so pages that re-render their own content (GitHub, for one) can't wipe them.

## Install

You need Chrome 120+ or Firefox 140+, and Node 26 or newer for the agent side.

```sh
git clone git@github.com:Farmer-Pete/anno-tater.git
cd anno-tater
npm ci
npm run build
```

- **Chrome:** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and pick `dist/chrome`.
- **Firefox:** signed builds come later. For now, open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`.

### Replies (optional)

Without anything else installed, the agent can show notes but you can't reply. For replies, register the helper once and restart the browser:

```sh
npm run tater -- install
```

This writes a small manifest that lets the browser start the helper (`src/host/main.ts`) over stdio. Browsers don't let an extension do this itself. Nothing listens on a network port.

## For the agent

```sh
npm run tater -- open notes.json      # store the notes and open the page
npm run tater -- push notes.json      # store or update notes; open pages update live (needs the helper)
npm run tater -- watch --owner NAME   # print the person's messages, one JSON line each
npm run tater -- reply <id> "text"    # answer a message in its thread
```

The notes format is in [docs/design.md](docs/design.md).

## Site access

Anno Tater only runs on sites you allow. When an agent leaves notes on a new site, the toolbar icon shows a badge. Click it and choose **Allow**, once per site.

## Development

`npm run check` runs the type checks, lint, dead-code and duplication checks, tests, and the build. A pre-commit hook runs it too: turn the hook on with `git config core.hooksPath .githooks`.
