# Tether

A Mac app for Claude Code. Each chat runs your own `claude` CLI, so your login, CLAUDE.md, skills, MCP servers and permission mode all apply, and sessions stay compatible with the terminal and VS Code. Tether adds what the terminal can't: voice input, circling things on screen, clickable file paths, a Shelf for pages Claude makes, approvals docked above the message box, and long chats that keep going with notes instead of compaction.

See the [one-page tour](https://htmlpreview.github.io/?https://github.com/jfroy525/tether/blob/main/docs/features.html) of what it does.

## Install

You need:
- A Mac with macOS 12 or newer (Apple silicon or Intel)
- [Claude Code](https://claude.com/claude-code), installed and logged in (run `claude` once in Terminal)
- Python 3.11 or newer, or [uv](https://docs.astral.sh/uv/)
- Optional: [GitHub CLI](https://cli.github.com) (`gh`) for pull requests in the Changes tab, VS Code for ⌥-click to open files

Then:

```sh
git clone https://github.com/jfroy525/tether.git
cd tether
zsh build_app.sh
open ~/Applications/Tether.app
```

The build makes `~/Applications/Tether.app`, which runs the code in this folder. If you move the folder, run `zsh build_app.sh` again.

**Updates:** when a newer Tether is on GitHub, a glowing download icon appears next to the settings gear. Click it to see what changed, then **Update and restart**. If Claude is working in any chat, Tether waits until it's done, and the chats you had open come back after the restart. If you installed before the update icon existed, update once by hand: `cd ~/tether && git pull`, then quit Tether (⌘Q) and reopen it.

The first time you use each of these, macOS asks for permission (System Settings › Privacy & Security):
- **Microphone:** dictation. Speech is turned into text on your Mac with Whisper; the speech model (about 150 MB) downloads the first time.
- **Screen Recording:** circling things on screen, Claude looking at your screen, and glass that adjusts to what's behind it.

## Cost and privacy

Tether uses your Claude Code login and plan; it has no account or server of its own. Chats cost what they cost in Claude Code. Notes and recall lookups use Haiku through the same login, about a cent per notes update and a tenth of a cent per lookup; Settings › Sessions turns notes off. Settings, notes and search indexes stay on your Mac in `~/Library/Application Support/Tether/`.

## Everyday use

| | |
|---|---|
| New session | ⌘N, pick a repo (type to filter) or choose a folder. **New folder…** makes a folder where you last made one (first time: ~/Claude Outputs if you have one, else your home folder; Change… picks another) and starts the session there. The **+** next to a sidebar group starts one in that folder |
| Switch | Click in the sidebar (the highlight slides to it), ⌘1–9 for open sessions. ⌘K (or Search) opens one list of sessions, repos to start in, and actions; type to filter, arrows and Return to pick |
| Talk | Hold **⌃⌥Space** anywhere and let go to drop the text in, or click the mic. Transcription runs on this Mac (Whisper) |
| Circle to explain | **⌃⌥C**, or the toolbox button next to the mic › Circle something on screen. Draw on the screen, then press Return. Claude gets a close-up and the whole screen |
| Attach files | The paperclip, or drop files anywhere on the window. Images under 3.7MB go in as pictures, everything else as its path for Claude to open. You can also paste images. Click an attachment to preview it |
| Approvals | Docked above the message box, so you never scroll to find one: Run / Always allow here / Deny (⌘↩ / ⌘⌫). Once answered, each goes back to its place in the chat as one line. Which actions ask is set by the permission mode, exactly as in the CLI |
| Stop | Esc |
| Inspector | The panel icon at the top right (⌘\\) opens one floating pane on the Shelf, with tabs for Shelf, Changes (GitHub's main with what each deploy target has, this branch, uncommitted and unpushed work, open PRs, unmerged branches; the repo is fetched with --prune at most every 5 minutes or on ↻), Commits, Notes and Stats (⌘I); ⌘J opens the Shelf too. Stats covers the whole chat: cost by model, what loaded in this session (each connector's status and tool count, plugins, your skills, built-in skills and agents, reported by Claude Code at start, no tokens), work, time and each session's share. The panel's top bar drags the window. Click a file to see its diff, ↗ opens it in VS Code. Repo tabs show for a chat started in a repo, or one where Claude edited files or ran a git commit or push in a repo (read from the chat's own history, across fresh starts). If there are several, click the repo name in the top bar to switch; the pick is saved per chat |
| Paths and links | Each part of a path is its own link: a folder opens in Finder, the file name opens a preview beside it (Open in the preview uses its default app, as set in Finder › Get Info › Open with). ⌥-click opens it in VS Code at the line, ⌘-click shows it in Finder. Images preview inline; links open in your browser |
| Previews | Click a file path, a Read row, an image or an attachment and a card pops out beside it: code with the lines Claude read lit, or the image. Space grows it to a large viewer and back, Esc closes it |
| Model, effort, mode | One menu next to Send, labeled like "Opus 5.5 · High · Auto" (Bypass shows in red). Modes: Auto, Ask first, Accept edits, Plan, Don't ask, Bypass (asks to confirm). ⇧Tab cycles the first four. The menu changes only the chat you're in; the model and effort for new chats, and the mode new and reopened sessions start in, are in Settings › Sessions. **Fast** asks for fast mode; it disappears once your account says it can't use it (Settings › Advanced shows why and can check again) |
| Context | The bottom of that menu shows how full the session is, measured against the point where Claude Code compacts on its own (your per-model limit in Claude settings counts, e.g. 600k for Opus 5.5). Amber at 60% and red at 80%, with the breakdown and **Compact now**, with an optional note on what to keep. Past sessions show the figure from their last reply until you click. Each compaction is a line in the chat: click **Summary** to read what Claude carried forward (the popover links to the latest) |
| Recall | Claude has a `recall` tool that searches the session's full saved history, including what compaction dropped and any session this one continues, and answers in a few lines with line numbers. Haiku reads the best passages (about $0.001 a lookup). The index lives in Tether's support folder and updates itself |
| Notes | Header › Notes: running notes for the session (decisions, exact facts, open items, gotchas, preferences), kept by Haiku once a session gets long, about a cent per update. After each update, a short check compares every new note with the few older notes most like it and drops any it replaces (the text stays in the file, the transcript in recall). Add, tick off or remove notes by hand. Settings › Sessions turns it off |
| Continue in a new session | In Notes, the context popover or a session's ⋯ menu: starts a fresh session with the notes, where the old one left off, and recall into its history, instead of compacting. It carries the last 40,000 characters of the conversation word for word, and each note dated; one Haiku pass (about a cent, up to a minute) leaves out notes a newer one replaced and marks finished or only-planned ones. That pass changes only the hand-off, not the stored notes. However many fresh starts a chat has, it keeps one notes file (named after its first session; older chats move over the first time they're opened, their old copies kept) with each session's read position, written under a lock with a .prev and a daily .day backup, and one search index for its finished sessions (all but the newest two), so a lookup opens three files at most. A session resumed after the chat moved past it gets its own notes file. Stats, repo tabs and the Shelf save what they read from each transcript, so finished sessions are read once. The new session shows a quiet "Continued from…" line. One fresh start at a time per session: the automatic one waits until the transcript shows the reply has ended and no background command or background agent is running, checks again just before switching, and tries again when the job ends; Start fresh is refused while one is on its way or the session already continues elsewhere (until you message the old one again). If the old session still answers after a switch, the chat says so with a link to it |
| Transcript size | Stats shows how much of the file is old screenshots (most of a long session). Remove them from before the last compaction; resuming behaves exactly the same and the original is kept as a compressed backup |
| Sub-agents | Each agent Claude starts gets its own lane under the call: type, task, live step, time, steps and tokens, with one tick per step. Agents started together share a count line ("3 agents · 2 running"). Background agents keep running in their lane until they report back. Click a lane for what it was asked, every step, and its report (past sessions too) |
| Working line | A runner hopping (and flipping, star-jumping, spinning) over code glyphs a ninja slicing them (slash, 360 spin, dash, X-cut), a dragon (fire breath, loop-the-loop, barrel roll, chomp), a soccer player (rainbow flick, nutmeg, step-over, juggling, and a shot when a goal comes by) or a snake (eats glyphs you can watch go down, strikes at flying ones, rattles, sheds its skin when long) (Settings › Appearance: any one, a different one each time, or a plain dot). Reduce motion turns it off |
| Text size | Settings › Appearance (90–160%) or ⌘+ / ⌘− / ⌘0; scales every font in the window. Color bold words (on by default) makes bold in replies the accent color, and links get an underline so they stay distinct |
| Accent color | Settings › Appearance: any color (picker or hex code), shaded per theme so accent text and button labels stay at 4.5:1 or better; Default goes back to teal |
| Reply animation | Settings › Appearance: Blur in (default), Scan line, Pop through or Off. Claude Code often hands over a whole reply at once (all pieces within 0.01 s, measured on Haiku, Sonnet and Opus), so Tether lays it out once and lets it land within about a second: words come into focus one after another, a glowing bar sweeps each line, or letters pop up through the glass, hang in the air and settle (replies over 2,500 characters pop word by word; letter-popped replies keep kerning off so lines don't move when they settle). The chat follows the newest line just above the message box. Rows that come after the text (tools, tables) wait until it has landed, and the finished reply is redrawn as plain text. Off when the chat isn't in front, on reopen, or with Reduce motion |
| Window | No title bar: drag the header or the top of the sidebar to move it, double-click there to zoom. Your desktop blurs through the window; Settings › Appearance › Transparency (0–100, live as you drag) sets how much, and 0 is a solid window. Above 55 the window's tint and macOS's own frosted layer fade out, and 100 is nearly clear glass. Frost (0–100, also live) sets how strongly the desktop behind is blurred, separately from transparency: 0 is sharp, 50 is the macOS default, 100 is twice as heavy. With Adjust to what's behind on (the default), the sidebar, chat, message box and panel each check what's behind them about once a second (a small capture of the desktop under the window, never the window itself; needs Screen Recording) and keep their faintest text at 4.5:1: the theme's colors when they read, the other theme's when those do, otherwise just enough extra tint. Without Screen Recording they plan for the worst case behind. Reduce motion turns off the animations |
| Queued messages | A message sent while Claude works waits at the bottom in the faint accent, labeled Queued. When Claude reads it (Claude Code's `--replay-user-messages` echo), it moves to that point in the conversation, so the reply below it answers it. Reopened chats show it in the same place |
| Several replies in a turn | In Chat view, each reply after the first starts below a hairline, so they don't run together |
| View | The switch in the header (⌘D cycles): Full (everything), Thinking (thinking + replies, no commands or tool calls), Chat (messages and replies). Hover an option to see what it shows; rows fade in when you switch. In Thinking, a live "Thinking · 4s" block opens as soon as Claude starts; Claude Code sends the thinking summary only when thinking ends, so it types in then. Theme in Settings: match system, dark or light |
| Artifacts | Claude writes a page, SVG, Markdown or code file and calls `show_artifact`; it opens on the side panel's **Shelf** tab (600px wide to start; drag the panel's left edge to resize, remembered per tab; double-click the edge resets it). The chat gets one line that reopens it. Pages run sealed: scripts work, nothing loads from or goes to the network, and the page can't reach Tether. Claude gets a picture of the page as the panel draws it (same width, same light or dark) plus any script errors, so it can fix what's broken (about 300–1,600 tokens a look). Every change is a version: the version label lists them, and you can look at an older one and Restore it (what was there stays as a version). Code files show the lines changed since you opened them, and File / Changes switches to the diff. ⤢ fills the window (Esc goes back), ⋯ opens it in the browser, shows it in Finder or copies the path. The Shelf is always there (⌘J); the name menu also lists what Claude showed lately in other chats, and picking one puts it on this chat's Shelf under Opened. With nothing of its own yet, the Shelf lists those directly. The Shelf updates by itself while it's open, and gets a dot when something changes elsewhere The Shelf lists this chat's items from the last day (Settings › Shelf: day, 3 days, week or the whole chat); older ones wait under Earlier in its item menu. Index pages go by their folder name |
| Notes on the Shelf | The speech-bubble button in the Shelf's top bar turns on commenting (Esc or Done turns it off). Click a spot on a page, SVG or picture, a line of code, or a Markdown paragraph, and type a note. Pins are numbered; click one to change or delete it. While commenting, clicks don't reach the page's own buttons. Notes wait above the message box (one chip per file; ✕ drops them) and go with your next message: one line each, and for a page the part under the pin (tag, class, text). Pages and pictures also send a picture with the pins (a page is drawn at the size you saw it, at most 800px wide, about 350–600 tokens) |
| Charts and diagrams | Tether ships Mermaid, Chart.js and D3 in `ui/lib` (5.7 MB). A Shelf page's usual CDN links (script tags or module imports) are swapped for these copies, so the page still works outside Tether. Each library crosses into the window once per run. ```mermaid blocks in replies and in Markdown on the Shelf draw as a picture, rendered in a hidden sealed frame; show code, copy, and open on Shelf (as a picture you can pin notes on). If Mermaid can't read a block it stays as code |
| Working marker | Scrolled up while Claude works: "Working" sits above the message box, then "New reply" (green dot) when it finishes. Click it to jump down and follow again |
| Previews and Shelf | **Open in panel** in a preview moves the file or picture to the Shelf, where it stays for this chat (listed under Opened in the name menu). Clicking a path that's already on the Shelf shows it there instead of a preview. Pages and Markdown preview drawn, with a Page / Code switch |
| Tables | Claude shows query results as sortable tables you can copy (pastes into Excel) or export as CSV to ~/Downloads/Tether exports (or ~/Claude Outputs/Tether exports if you have that folder) |

Settings (⌘,) holds the hotkeys, mic, speech model, work words for dictation, how long marks stay up, notifications, pinned repos and how many days of history to show.

## Files

- `workbench.py`: the window, hotkeys, screen overlays and bridge to the page
- `engine.py`: one `claude -p` stream-json process per session (permissions, diffs, events)
- `history.py`: past sessions from ~/.claude/projects · `repos.py`: git, gh and (if you use it) Databricks status and repo discovery
- `voice.py`: dictation · `screen.py`, `markup.html`: screenshots and marks
- `recall.py`: the per-session search index and the Haiku lookup · `notes.py`: running notes · `slim.py`: removes old screenshots from transcripts
- `updater.py`: checks GitHub for a newer Tether (at most every 6 hours), updates this folder and restarts
- `wb_mcp.py`: tools for Claude (look_at_screen, list_windows, mark_up_screen, show_table, show_artifact, recall, session_notes)
- `artifacts.py`: the Shelf's versions and which chat showed each (in the support folder, never the project), sealed pages, changed lines · `artifact_snap.py`: draws a page off screen for Claude to look at
- `ui/`: the page (`app.js`, `markdown.js`, `runner.js` and `critters.js` for the working-line animations, `app.css` for the Float glass layout) · `make_icon.py`: the Tether icon

Logs: ~/Library/Logs/Tether.log. Settings: ~/Library/Application Support/Tether/.

## License

See [LICENSE](LICENSE). Mermaid, Chart.js and D3 in `ui/lib` keep their own licenses (MIT and ISC), next to each file.
