---
name: anno-tater
description: Anno Tater marks up a web page in the person's browser with highlights, explanations, numbered steps, glossary definitions, and arrows, and carries their replies back. Use when the person wants feedback, a review, or explanations shown on a web page, or manual steps to follow on one; or when a message arrives from an Anno Tater page.
---

# Anno Tater

You write one JSON notes file per page. The person's browser extension anchors each note to text on the page and draws it. With the helper installed, the person can reply from the page and you answer from here.

Run the CLI as `~/.local/share/anno-tater/bin/tater`. If that file is missing, ask the person to run `npm run tater -- install` in their anno-tater clone, then continue.

## Steps

1. **Read the page as rendered.** Every note anchors on a `quote`: exact text as the browser shows it, with markdown markup gone (no backticks or asterisks) and runs of whitespace collapsed to one space. Take quotes from the rendered page, not from source files. Keep each quote inside one paragraph, list item, table cell, or heading. When a quote appears more than once, add `prefix` and/or `suffix` (a few words just before or after it). Done when every quote is copied from rendered text.
2. **Write the notes file** in your scratch directory, never in a repo the page belongs to. Format: [reference.md](reference.md). Pick an `owner` that names this task (`seg-247-review`); replies for this file go to that inbox. Done when `tater check <file>` prints `ok`.
3. **Show it.** `tater open <file>` stores the notes and opens `url` in Chrome (`--browser firefox` for Firefox). The first time on a site the person clicks Allow once. After that, `tater push <file>` updates the notes, and open pages redraw live when the helper is installed.
4. **Check placement.** Ask the person whether anything sits in the panel's "Couldn't place" list, and fix those quotes.
5. **Listen for replies.** `tater status` shows whether the helper is installed. If it is, start a Monitor on `tater watch --owner <owner>`: each new message arrives as one JSON line with `id`, `kind`, `noteId`, `quote`, and `text`.
6. **Answer every message** with `tater reply <id> "<text>"` (use `-` and stdin for long text). The answer lands in that note's thread, and the page shows the person an alert. Per kind:
   - `reply`: answer the question in the thread.
   - `ask`: a question about text they selected; your reply becomes a new note anchored there.
   - `done` / `undone`: a step was ticked; reply if it changes what happens next, otherwise `tater ack <id>`.

   Done when `tater watch --once --owner <owner>` prints nothing.

To change a note's wording, edit the file and `tater push` it again. Keep each note's `id` stable so threads and read state carry over.
