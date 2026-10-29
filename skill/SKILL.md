---
name: tater
description: Anno Tater marks up a web page in the person's browser with highlights, explanations, numbered steps, glossary definitions, and arrows, and carries their replies back. Use when the person wants feedback, a review, or explanations shown on a web page, or manual steps to follow on one; or when a message arrives from an Anno Tater page.
---

# Anno Tater

You write one JSON notes file per page. The person's browser extension anchors each note to text on the page and draws it. With the helper installed, the person can reply from the page and you answer from here.

Run the CLI as `node <this skill's base directory>/bin/tater.mjs`, called `tater` below. If `bin/tater.mjs` is missing, the skill was copied without its build: ask the person to rerun the Anno Tater installer.

## Steps

1. **Read the page as rendered.** A note anchors on a `quote`: exact text as the browser shows it, with markdown markup gone (no backticks or asterisks) and runs of whitespace collapsed to one space. Take quotes from the rendered page, not from source files. Keep each quote inside one paragraph, list item, table cell, or heading. When a quote appears more than once, add `prefix` and/or `suffix` (a few words just before or after it). A note about the whole page (a summary, a reading guide, "start here") has no `quote`; it shows at the top of the panel. Done when every quote is copied from rendered text.
2. **Write the notes file** in your scratch directory, never in a repo the page belongs to. Format: [reference.md](reference.md). Done when `tater check <file>` prints `ok`.
3. **Show it.** `tater open <file>` stores the notes and opens `url` in the person's default browser (`--browser chrome|zen|firefox-dev` to choose). The page URL is the key: a page has one notes file and one conversation, in every browser. `tater push <file>` updates it, and open pages redraw live when the helper is installed. The first time on a site the person clicks Allow once.
4. **Check placement.** Once the page has loaded, `tater status --page <url>` shows what it placed: `unplaced` quotes aren't on the page as written, and `ambiguous` ones matched more than once and need a `prefix` or `suffix`. Fix them and push again. A `stale` line means the page hasn't redrawn since your last push; without the helper there is no report, so ask the person to read the panel's "Couldn't place" list instead.
5. **Listen for replies.** `tater status` shows whether the helper is installed. If it is, start a Monitor on `tater watch --page <url>` (open and push print it; for several pages, one watcher with `--page` repeated, or `--all` for every page): each new message arrives as one JSON line with `id`, `kind`, `noteId`, `url`, `quote`, and `text`. The Monitor stops after its timeout; when it does, start it again. Nothing is lost while it's down: on start it prints every message still unanswered.
6. **Answer every message** with `tater reply <id> "<text>"` (use `-` and stdin for long text). The answer lands in that note's thread, and the page shows the person an alert. Per kind:
   - `reply`: answer the question in the thread. When several messages arrive on one note, `tater reply --note <noteId> "<text>"` answers them all at once, oldest first, so an answer can't land under the wrong message.
   - `ask`: a question about text they selected; your reply becomes a new note anchored there.
   - `done` / `undone`: a step was ticked; reply if it changes what happens next, otherwise `tater ack <id>`. On a walkthrough where ticks need no answer, start the watcher with `--skip done,undone`: it acks them for you and never wakes you for them.

   Done when `tater watch --once --page <url>` prints nothing.

To change a note's wording, edit the file and `tater push` it again. Keep each note's `id` stable so threads, ticked steps, and read state carry over; the stored copy keeps the threads. A page has one owner: `tater push` and `tater open` refuse to replace notes another Claude Code session wrote. Ask the person before taking a page over with `--force`; the two sessions would still share its replies.
