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

You need Chrome 120+, Firefox 140+, or Zen, plus Node 20 or newer.

```sh
curl -fsSL https://raw.githubusercontent.com/Farmer-Pete/anno-tater/main/install.sh | sh
```

Or from a clone (needs Node 26 and npm): `./install.sh`. Either way it:

- installs the `tater` skill into `~/.claude/skills/tater`, so Claude can write notes and answer replies;
- registers the helper with every browser it finds, so you can reply from the page;
- opens the signed add-on in Firefox and Zen (click **Add**);
- copies the Chrome build to `~/.local/share/anno-tater/chrome` and tells you the two clicks Chrome needs (Developer mode, then **Load unpacked**). Chrome only installs extensions from outside its store that way.

Browsers don't let an extension register the helper itself, which is why the installer does it. The helper talks to the browser over stdio. Nothing listens on a network port. Without the helper, Claude can still show notes, but you can't reply.

## Using it

Ask Claude to mark up a page, for example: "Review this design doc and mark it up with tater." The skill writes the notes, opens the page in your default browser, and answers what you send back.

Under the hood the skill runs `tater`:

```sh
tater open notes.json      # store the notes and open the page in the default browser
tater push notes.json      # update notes; open pages redraw live (needs the helper)
tater watch --owner NAME   # print the person's messages, one JSON line each
tater reply <id> "text"    # answer a message in its thread
```

Each page gets its own inbox (`owner`), so several Claude sessions can each annotate their own page, in one browser or several, without seeing each other's messages. The notes format is in [skill/reference.md](skill/reference.md), and the design in [docs/design.md](docs/design.md).

## Site access

Anno Tater only runs on sites you allow. When an agent leaves notes on a new site, the toolbar icon shows a badge. Click it and choose **Allow**, once per site.

## Development

`npm run build` writes `dist/chrome`, `dist/firefox`, and the skill's bundled `skill/bin`. `npm run sign:firefox` signs the Firefox build on addons.mozilla.org (unlisted; needs an API key in `~/.amo.token`), and `npm run release` publishes a GitHub release with the files `install.sh` downloads.

`npm run check` runs the type checks, lint, dead-code and duplication checks, tests, and the build. A pre-commit hook runs it too: turn the hook on with `git config core.hooksPath .githooks`.
