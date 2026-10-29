# Notes file reference

```json
{
  "url": "https://github.com/org/repo/blob/main/docs/design.md",
  "title": "Design review",
  "scope": "article.markdown-body",
  "notes": [
    { "id": "s1", "kind": "step", "step": 1, "quote": "Summary", "title": "Read the summary", "body": "Then mark this step done." },
    { "id": "n1", "kind": "issue", "quote": "stores the parsed list", "title": "The list isn't what the doc says",
      "body": "NCA sends the merged list.\n\n- Set at `parser.rs:231`\n- Sent by `export.rs:61`", "decorate": "box" },
    { "id": "n2", "kind": "info", "quote": "mixes two concepts", "title": "The doc's own objection" }
  ],
  "links": [{ "from": "n2", "to": "n1", "label": "reused here" }],
  "glossary": [{ "term": "NCA", "def": "network-config-analysis: parses device configs." }]
}
```

## Top level

| Field | Required | Meaning |
| --- | --- | --- |
| `url` | yes | The page. Its address without `https://` or `#…` is the key: one notes file, one shared state, and one conversation per page. A fragment route (`#/settings`, `#!/settings`) is part of the key, since single-page apps use it to pick the page, so copy the address with its route. It also tells the extension which site needs access. |
| `title` | no | Shown in the panel header. |
| `scope` | no | CSS selector for the page's main content (`article.markdown-body` on GitHub). Quotes and terms outside it are ignored, which keeps nav bars and sidebars out. Default: `main`, else `body`. |
| `notes` | yes | The notes, below. |
| `links` | no | Arrows between two notes, drawn down the left margin: `from`, `to` (note ids), optional `label`. |
| `glossary` | no | `term` and `def`. Every whole-word use of `term` (case-sensitive) gets a dotted underline and a hover definition. |
| `acked` | managed | Message ids already handled. `tater reply` and `tater ack` maintain it; keep it when you edit the file. |
| `session` | managed | The agent session that wrote the notes. `tater push` sets it and refuses to replace another session's notes without `--force`. |

## Notes

| Field | Meaning |
| --- | --- |
| `id` | Unique, stable across edits. |
| `kind` | `issue` (red, a problem), `caution` (amber, a risk or doubt), `agree` (green, endorse this), `info` (blue, context), `step` (purple numbered pin, an action for the person). |
| `quote` | Exact rendered text to anchor on. Leave it out for a note about the whole page, such as a summary or a reading guide: the panel lists it under "On this page", above the anchored notes, and clicking it opens its card. |
| `prefix`, `suffix` | Text just before or after the quote, to pick one of several matches. |
| `title` | One line: the point of the note. Shown on hover and in the panel. |
| `body` | Details, shown on click. Paragraphs split by a blank line, `- ` bullet lists, GitHub-style tables (header row, `---` rule row, body rows), fenced code blocks (```` ```python ````; `diff` colors `+` and `-` lines), `` `code` ``, `**bold**`, `[text](https://…)`. |
| `step` | The step number, for `kind: "step"`. |
| `decorate` | Extra emphasis drawn around the text: `box`, `circle`, `underline`, `bracket`. Use sparingly. |
| `thread` | The conversation: `{ "from": "you" \| "claude", "text": "…" }`. `tater reply` appends to it. |

## Writing notes that help

- Lead the `title` with the conclusion ("NCA adds VLANs the config never allowed"), and put evidence with file:line references in the `body`.
- Anchor the note on the claim it disputes, not on nearby words. A note on the wrong phrase points the reader at the wrong problem.
- One idea per note. Link related notes instead of repeating them.
