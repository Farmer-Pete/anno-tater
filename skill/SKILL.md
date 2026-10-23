---
name: tater
description: Anno Tater marks up a web page in the person's browser with highlights, explanations, numbered steps, glossary definitions, and arrows, and carries their replies back. Use when the person wants feedback, a review, or explanations shown on a web page, or manual steps to follow on one; or when a message arrives from an Anno Tater page.
---

# Anno Tater

You write one JSON notes file per page. The person's browser extension anchors each note to text on the page and draws it. With the helper installed, the person can reply from the page and you answer from here.

Run the CLI as `node <this skill's base directory>/bin/tater.mjs`, called `tater` below. If `bin/tater.mjs` is missing, the skill was copied without its build: ask the person to rerun the Anno Tater installer.

## Steps

1. **Read the page as rendered.** Every note anchors on a `quote`: exact text as the browser shows it, with markdown markup gone (no backticks or asterisks) and runs of whitespace collapsed to one space. Take quotes from the rendered page, not from source files. Keep each quote inside one paragraph, list item, table cell, or heading. When a quote appears more than once, add `prefix` and/or `suffix` (a few words just before or after it). Done when every quote is copied from rendered text.
2. **Write the notes file** in your scratch directory, never in a repo the page belongs to. Format: [reference.md](reference.md). Done when `tater check <file>` prints `ok`.
3. **Show it.** `tater open <file>` stores the notes and opens `url` in the person's default browser (`--browser chrome|zen|firefox-dev` to choose). The page URL is the key: a page has one notes file and one conversation, in every browser. `tater push <file>` updates it, and open pages redraw live when the helper is installed. The first time on a site the person clicks Allow once.
4. **Check placement.** Ask the person whether anything sits in the panel's "Couldn't place" list, and fix those quotes.
5. **Listen for replies.** `tater status` shows whether the helper is installed. If it is, start a Monitor on `tater watch --page <url>` (open and push print it): each new message arrives as one JSON line with `id`, `kind`, `noteId`, `url`, `quote`, and `text`. The Monitor stops after its timeout; when it does, start it again. Nothing is lost while it's down: on start it prints every message still unanswered.
6. **Answer every message** with `tater reply <id> "<text>"` (use `-` and stdin for long text). The answer lands in that note's thread, and the page shows the person an alert. Per kind:
   - `reply`: answer the question in the thread.
   - `ask`: a question about text they selected; your reply becomes a new note anchored there.
   - `done` / `undone`: a step was ticked; reply if it changes what happens next, otherwise `tater ack <id>`.

   Done when `tater watch --once --page <url>` prints nothing.

To change a note's wording, edit the file and `tater push` it again. Keep each note's `id` stable so threads, ticked steps, and read state carry over; the stored copy keeps the threads. Two sessions working on the same page replace each other's notes and share its replies, so keep one session per page.
