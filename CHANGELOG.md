# Change log

What changed in each Tether update, newest first. Tether shows the entries your copy doesn't have yet in the
update box, and the whole list in Settings › Updates › Change log.

Each update adds one entry at the top: `## YYYY-MM-DD · Title`, then a short line per change.

## 2026-11-13 · Tables show in full
- Tables in chat show at full height instead of scrolling inside a box; they scroll sideways only when the columns can't fit.

## 2026-11-13 · Tables wrap
- Tables in chat wrap long text onto more lines instead of cutting it off with “…”. Numbers stay on one line.

## 2026-11-12 · Restarts wait for follow-ups
- A restart or update waits 30 seconds after a background job or agent ends, so Claude can follow up on it first. An automatic fresh start waits the same way.
- Restarting or updating from inside Tether stops each chat's Claude first, like ⌘Q, so no chat keeps working where you can't see it.
- Update on its own when idle restarts for changes to Tether's files only once they're pushed to GitHub, not while they're being edited.

## 2026-11-12 · Option+Enter for a new line
- Option+Enter starts a new line in the message box and in a queued message you're editing, like Shift+Enter, instead of sending.

## 2026-11-12 · Editing a queued message
- While you edit a queued message, the chat scrolls as the box grows, so Enter saves, Esc cancels and the buttons stay in view above the message box.

## 2026-11-11 · Top bar and the panel by the Dock
- The line under a chat's title stays on one row: a branch name that doesn't fit hides (hover the repo name for it), and the pull request status keeps its place.
- Drag the window by any part of the top bar except its controls.
- Settings › Notifications draws the Dock on the side it really is, adds a Bottom center spot, and By the Dock follows the Dock to the left, right or bottom.

## 2026-11-11 · Waiting on you, floating over other apps
- While Tether is in the Dock, hidden or behind another app, what needs you floats over the app you're in: questions, approvals, handoffs and failed jobs.
- Answer, Run or Deny, and send a handoff right from it, without bringing Tether forward. Type a reply there too; after you send, the keyboard goes back to your app.
- Settings › Notifications: turn it on or off, pick where it shows (a corner, by the Dock, or drag it anywhere), start it folded, choose what it shows, and hide details while you share your screen.
- The model button by Send no longer leaves a gap before Send, and a long model name shortens itself so the effort and mode always show.

## 2026-11-11 · Pinned order and the context menu
- A pinned chat keeps its place in Pinned after a fresh start, instead of jumping to the top.
- The context section of the model menu fits at larger text sizes: the Compact now button stays in its column, and the two links don't break mid-line.

## 2026-11-11 · See what's in an update
- Hover the update icon to see what the update has in it: the new change log entries, and a Claude Code update if there is one.

## 2026-11-11 · Your messages stay on the right
- After a fresh start, your messages from the earlier part of the chat sit on the right again, like the rest.

## 2026-11-11 · Waiting on you after a restart
- After a restart, only questions you hadn't seen come back under Waiting on you, with their real time.
- A reply counts as a question only when it asks you something, not when it just ends with a "?".

## 2026-11-11 · Change log
- This change log. The update box lists what's new before you update.
- Settings › Updates › Change log shows every update, with anything not installed yet at the top.

## 2026-11-11 · Model menu by company
- Models are grouped by company. Anthropic is at the top and open; every other company folds to one row.
- The company of the model you're using opens by itself, and the list scrolls to it.
- Settings › Model for new chats uses the same company headings.
- Without a gateway, the menu is the same plain Claude list as before.

## 2026-11-11 · Tidier restart list
- The line above the waiting chats reads "Restart waits for" (or "Update waits for") and fits beside Cancel.
- The reasons line up on the right. Long chat names shorten before them; hover a row to read both in full.

## 2026-11-11 · Other models through a gateway
- If Claude Code goes through a gateway that also serves non-Claude models (GPT, Kimi, GLM, DeepSeek and others), they show in the model menu, with price and context size where the gateway lists them.
- Tether lists only models that answer. It reads the gateway's list once a day for free and checks only new models, with one tiny request each.
- Other model… checks any model ID you type before switching to it.
- A model that's refused stops at once, with one plain line, instead of minutes of retries. It leaves the menu.
- Settings › Sessions › Other models shows how many work, with Check now.
- Stats uses the gateway's prices instead of Claude Code's guess.
- A question you've already looked at leaves Waiting on you. Its buttons stay in the chat.

## 2026-11-11 · Handoffs, update when idle, and a clearer restart wait
- Hand off to another chat: ask in words, or use the ⋯ menu or ⌘K. The other chat gets a card with Send, Edit and Dismiss; nothing is sent until you click. Unsent handoffs survive a restart.
- Restart when idle lists each chat it's waiting for and why. Click one to go there.
- Settings › Updates › Update on its own when idle (off by default): installs updates and restarts once nothing is running and you're not typing.
- Waiting on you leaves out the chat in front of you, and both sides in split view.
- Answer buttons keep working after a fresh start.
- A background agent can no longer keep a chat busy forever.

## 2026-11-10 · Drag pinned chats; smoother split view
- Press and drag a pinned chat to reorder. The order is saved and used by the mini window too.
- Split view slides the new chat in and the closed one out. Open beside loads the chat behind first.

## 2026-11-10 · Answer buttons, Waiting on you, split view
- When Claude asks something short, the answers show as buttons under the reply.
- Waiting on you lists every chat that needs you: approvals, questions, finished replies, failed jobs.
- Two chats side by side, with one message box that moves between them.
- Pick buttons on Shelf mockups send your choice as a reply.
- Restart when idle (Settings › Updates and ⌘K) waits for chats and jobs, then restarts and reopens them.

## 2026-11-10 · Running agents in the Running note
- The note above the message box counts background agents as well as jobs. Click a row to jump to that agent.

## 2026-11-08 · Chat width
- Settings › Appearance › Chat width: Narrow, Medium, Wide, Wider or Full window.

## 2026-11-06 · Turns Claude starts on its own
- When a background job ends and Claude carries on by itself, the chat shows as working.
- A turn Claude runs on its own (for example after a restart) no longer ends yours early.

## 2026-11-06 · Highlights page
- A highlights page, linked from the README, shows the main features with an install command at the top.
- The Shelf shows the newest thing Claude showed when you come back to a chat.

## 2026-11-05 · Fast mode and the Dock
- Clicking Fast asks Claude Code properly. If your organization says no, Tether explains and hides the button.
- The Dock icon pulses while a chat is working (Settings › Appearance).

## 2026-11-05 · Shelf menu by day
- The Shelf menu has a Find box and days newest first, each grouped into Mockups, Pages, Files and Pictures.
- Deleted or moved files are left off the Shelf. The separate "Show items from" setting is gone.
- Keep scrolling up past the top of a chat to open its earlier session.
- Toolbox › Pick a color from the screen puts its hex code in the message box.

## 2026-11-05 · Older Claude Code, and updating it
- Tether works with older Claude Code versions by leaving out options they don't know.
- Planned stops no longer show as errors.
- Settings › Updates shows Tether's version, the last check or why it can't check, and Check now.
- When Claude Code has a newer version, a glowing icon offers to update it.

## 2026-11-05 · Report a problem
- Error lines have a Report link, and Settings › Advanced has Report a problem. You see a preview first; it opens a filled-in GitHub issue with your user name removed.
- When Claude Code stops with an error, the line says why.
- Toolbox descriptions wrap instead of being cut off.

## 2026-11-05 · Updates take GitHub's version
- The Fast button shows only for Opus.
- Updating sets aside any local edits in git first, so nothing is lost. It checks hourly instead of every 6 hours.

## 2026-11-05 · Fewer dropped messages
- A message that hits a closed connection restarts Claude Code once and goes again. If it fails twice, you see why.
- Mark up a window skips the Mac's own system windows.

## 2026-11-05 · Working line and the Dock
- The working line shows what Claude is on, like "Editing · 32s", with the file or command it's working with.
- Clicking the Dock icon brings the window back.

## 2026-11-05 · Toolbox, side questions and screen tools
- Toolbox: a search list with up to 3 favorites in the message box.
- Side questions (⌘/ or /btw) open in a popout joined to the message box.
- Mark up a window, copy text from the screen, and lift a table onto the Shelf.
- Queued messages can be edited or sent now. The Mac's right-click menu works in chats.
- Background jobs are tracked from start to end, and the Shelf keeps each page's state without flashing white.

## 2026-11-02 · Mini window
- ⌘⇧M shrinks Tether to one chat in the corner, above other apps. Click the chat name to switch to any chat.
- The line under the chat name only shows what needs attention, like a branch or files not on GitHub.

## 2026-11-02 · Notifications
- Notifications show Tether's name and logo, and a click opens that chat.
- After this update, macOS asks once more for Screen Recording and Microphone.

## 2026-11-02 · Update from inside Tether
- A glowing icon next to Settings appears when there's an update. One click lists the changes, updates, and restarts, then reopens your chats.

## 2026-11-02 · Feature page
- The feature page has the install command at the top, and its links scroll to the right section.

## 2026-11-02 · First release
- Tether: a Mac app for Claude Code, with voice input, circling things on screen, clickable file paths, a Shelf for pages Claude makes, approvals in the chat, and long chats that carry on with notes instead of compaction.
