# Anno Tater design

Anno Tater lets a coding agent such as Claude Code mark up any web page for a person. The agent writes one small JSON file per page. The browser extension draws it: highlights that explain a problem, numbered steps, glossary hovers, boxes and arrows. The person can reply from the page, and the reply reaches the agent that wrote the notes.

## Goals

- **Cheap for the agent.** The agent writes a notes file once. The extension does the anchoring and drawing. A reply from the page reaches the agent as one short line, never as the page.
- **Marks that stay.** Highlights survive reloads and pages that re-render their own DOM.
- **Least privilege.** The extension runs only on sites the person allowed, one click per site.
- **Chrome and Firefox** from one code base.
- **Works without installing anything else.** Without the helper, notes still reach the page. Replies need the helper.

## Pieces

```mermaid
flowchart TB
  A["Agent"] -->|"tater push / tater open"| F[("Data folder<br/>pages/*.json, inbox/*.jsonl")]
  A -->|"tater open, no helper"| O["Extension intake page<br/>(notes in the URL fragment)"]
  F <-->|"files"| H["Helper<br/>(native messaging host)"]
  H <-->|"stdio, started by the browser"| B["Extension background"]
  O --> B
  B <--> C["Content script + engine<br/>(on allowed sites)"]
  C --> P["The page"]
  F -->|"tater watch"| A
```

- **`tater` CLI** (`src/cli`). Validates and stores notes files, opens pages in the default browser, prints new replies for the agent, and installs the helper. The build bundles it, with the helper, into `skill/bin` for the Claude Code skill.
- **Helper** (`src/host`). A native messaging host. The browser starts it on demand over stdio, so it needs no open port and nothing else can reach it. It reads notes files, tells the extension when one changes, and appends the person's messages to an inbox file.
- **Background** (`src/extension/background.ts`). Holds the notes cache, talks to the helper, registers the content script for allowed sites, and drives the toolbar badge.
- **Content script and engine** (`src/extension/content.ts`, `src/engine`). Anchors notes to text and draws them.
- **Shared** (`src/shared`). The notes schema, URL matching, and the native messaging framing.

## Two modes

| | No helper | With helper |
| --- | --- | --- |
| Install | The extension only | Plus the helper, registered by `install.sh` (or `tater install`) |
| Agent to page | `tater open` carries the notes to the extension's intake page in the URL fragment | `tater push` writes a file; open pages update live |
| Page to agent | None. Cards hide the reply box | Replies, questions on a selection, and "Mark done" land in the agent's inbox |

### Why the intake page, not the target URL

`tater open` could put the notes in the target page's own fragment. The fragment never reaches the site's server, but the site's scripts could read it on a domain the extension can't run on yet, and seeing that URL at all needs the "tabs" permission ("Read your browsing history"). Instead `tater open` opens the extension's own `open.html` with the notes in its fragment. That page stores them, asks for site access if needed (the click there counts as the required user gesture), and then sends the browser on to the target page.

Chrome: the manifest's `key` fixes the extension ID, so the intake URL is known in advance. Firefox and Zen give each install a random internal host name; `tater` reads it from the profile's `prefs.js` (`extensions.webextensions.uuids`).

## Notes file

```json
{
  "match": "github.com/org/repo/blob/main/docs/design.md",
  "title": "Design review",
  "owner": "seg-247-review",
  "scope": "article.markdown-body",
  "notes": [
    { "id": "n1", "kind": "issue", "quote": "exact text on the page", "prefix": "optional", "suffix": "optional",
      "title": "Short title", "body": "Markdown subset", "decorate": "box", "thread": [] }
  ],
  "links": [{ "from": "n1", "to": "n2", "label": "same root cause" }],
  "glossary": [{ "term": "NCA", "def": "network-config-analysis" }],
  "acked": []
}
```

- `match` is a substring of the page URL.
- `owner` names the inbox that receives replies. It defaults to one inbox per page (`page-<hash>`), so agents working on different pages never share one. `tater open` and `tater push` print the `tater watch --owner <name>` command for it.
- `kind` is one of `issue`, `caution`, `agree`, `info`, `step`. Steps also have `step: <number>`.
- `decorate` is one of `box`, `circle`, `underline`, `bracket`.
- Anchoring follows the W3C TextQuoteSelector: an exact quote with optional prefix and suffix. A quote that isn't found goes in the panel's "Couldn't place" list. Nothing is placed by a guess.

## Rendering

- Text highlights use the CSS Custom Highlight API. It paints ranges without changing the DOM, so a page re-rendering its own nodes can't erase them. A MutationObserver re-anchors when the nodes under a range are replaced.
- Cards, the panel, pins, and SVG arrows live in one Shadow DOM host, so page CSS and our CSS don't touch.
- Keys typed in our UI never reach the page. From the page's side they look like they come from a plain element, so its shortcuts would fire. A "Block site shortcuts" toggle (on by default) also blocks the page's shortcuts outside its own text fields.

## Several browsers and sessions

Each browser starts its own helper; all of them share one data folder. Notes files aren't tied to a browser, and replies route by owner, so two Claude sessions can chat through Chrome and Zen at the same time without crossing. Receipts (`delivered.jsonl`) and inboxes are append-only, so concurrent writers don't overwrite each other. Two sessions writing notes for the same page do collide: the last `push` wins, and `push` warns when it replaces another owner's notes.

## Native messaging

Each message is a 4-byte little-endian length followed by UTF-8 JSON. The browser caps a message to the extension at 1 MB. `tater install` writes the host manifest to:

- Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Firefox and Zen: `~/Library/Application Support/Mozilla/NativeMessagingHosts/` (Zen reads Mozilla's folder, zen-browser/desktop#13214)

It also writes a launcher script with the absolute path to `node`, because apps started from the Dock don't get the shell's PATH.
