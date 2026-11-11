#!/usr/bin/env python3
"""Tether: a desktop window for Claude Code sessions, repos and screen tools."""

from __future__ import annotations

import base64
import csv
import datetime
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path

import webview

try:  # trust the macOS keychain for TLS (corporate proxy), e.g. the speech model's first download
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

import artifacts
import engine
import history
import notes
import recall
import slim
import repos
import rightclick
import notifier
import mini
import updater
import cc_update
import screen
import lift
import voice
from hotkey import HOTKEYS, SpeakKey

APP_NAME = "Tether"
OLD_SUPPORTS = [Path.home() / "Library/Application Support" / n for n in ("Anvil", "JordCode", "Claude Workbench")]
HERE = Path(__file__).resolve().parent
SUPPORT = Path.home() / "Library/Application Support" / APP_NAME
SETTINGS_FILE = SUPPORT / "settings.json"
LIMITS_FILE = SUPPORT / "context-limits.json"
EXPORTS = (Path.home() / "Claude Outputs" if (Path.home() / "Claude Outputs").is_dir() else Path.home() / "Downloads") / "Tether exports"
DEFAULTS = {
    "model": "",              # "" = your Claude Code default
    "panel_w": {},            # side panel width per tab, from dragging its edge ({"view": 640})
    "new_folder_in": "",      # where New folder… last made one; "" = not used yet
    "effort": "",
    "show_thinking": True,
    "keep_notes": True,
    "auto_fresh": 200000,     # start a fresh session (notes + recall carry over) once context passes this; 0 = never       # long sessions get running notes (Haiku), used by recall and handoffs
    "working_anim": "mix",
    "fast_unavailable": "",   # why this account can't use fast mode (hides the Fast button); cleared by Check again    # runner | ninja | dragon | soccer | wizard | mix | dot
    "perm_mode": "",          # "" = your Claude Code default (auto for you); new sessions start in this
    "fast": False,
    "theme": "system",        # system | dark | light
    "text_size": 100,         # percent; scales every font size in the window
    "chat_width": 860,        # px the chat text and message box may grow to; 0 = the whole chat pane
    "accent": "",             # "#RRGGBB" from Settings › Appearance; "" = the theme's teal
    "bold_accent": True,      # bold words in replies take the accent color
    "select_anim": "glow",    # selected text: "glow" (flashes as you let go), "liquid" (glides after the pointer), "marker" (paints each line) or "off"
    "reply_anim": "blur",     # how a reply lands: "blur" (words come into focus), "scan" (a bar sweeps each line) or "off"
    "view": "full",           # full = everything; thinking = thinking + replies, no tool calls; chat = just messages and replies
    "transparency": 55,       # 0–100: how much of the desktop shows through the window; 0 = solid, no blur
    "frost": 50,              # 0–100: how strongly the desktop behind is blurred, apart from transparency; 50 = macOS's own
    "glass_adapt": True,
    "dock_pulse": True,       # the Dock icon glows softly while any chat is working      # each pane switches light/dark text, or adds tint, by what's behind it, so text stays readable
    "voice_key": "ctrl+alt+space",
    "circle_key": "ctrl+alt+c",
    "markup_key": "ctrl+alt+m",
    "tool_favs": ["circle", "window"],  # toolbox tools kept in the message box (the star in the toolbox)
    "whisper_model": "base",
    "mic": "",
    "vocabulary": "",
    "auto_send_dictation": False,
    "mark_linger": 30,
    "notify": True,
    "history_days": 45,
    "claude_path": "",
    "pinned": [],
    "mini_on_top": True,      # the mini window floats above other apps (its pin button)
    "mini_frame": [],         # where you last left the mini window: x, y, width, height (macOS points)
}
FULL_MIN, MINI_MIN, MINI_SIZE = (900, 560), (320, 380), (380, 580)


def load_settings() -> dict:
    try:
        saved = json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        saved = {}
    return {**DEFAULTS, **{k: v for k, v in saved.items() if k in DEFAULTS}}


class Api:
    """Methods the page can call. Underscore names are hidden from JavaScript."""

    def __init__(self):
        self._window = None
        self._mini_on, self._full_frame, self._mini_timer = False, None, None
        self._ready = False
        self._outbox: queue.Queue = queue.Queue()
        self.settings = load_settings()
        self._sessions: dict[str, engine.Session] = {}
        self._side: dict[str, dict] = {}  # chat id -> its side question copy (see side_ask)
        self._overlays: list = []
        self._shown: set = set()
        self._mark_gen = 0
        self._overlay_hide = None
        self._marks_up = False
        self._circle_displays = None
        self._pick: dict | None = None  # Mark up a window, while it's on (see start_circle)
        self._dictation = voice.Dictation(lambda lvl: self._emit({"type": "level", "level": lvl}))
        self._voice_key = SpeakKey(lambda: self._bg(self._voice_down), lambda: self._bg(self._voice_up),
                                   key_id=1, name="voice key")
        self._circle_key = SpeakKey(lambda: None, lambda: self._bg(self.start_circle), key_id=2, name="circle key")
        self._markup_key = SpeakKey(lambda: None, lambda: self._bg(self.start_circle, "window"), key_id=3, name="markup key")
        threading.Thread(target=self._send_loop, daemon=True).start()

    @staticmethod
    def _bg(fn, *args) -> None:
        threading.Thread(target=fn, args=args, daemon=True).start()

    # ----- events to the page -----

    def _emit(self, ev: dict) -> None:
        t, sid = ev.get("type"), ev.get("sid")
        if t == "markup":
            self._bg(self._markup, ev.get("marks") or [])
        if t == "artifact" and ev.get("path"):  # each show is a version, with Claude's note of what changed
            artifacts.snapshot(ev["path"], ev.get("note") or "", sid or "", ev.get("title") or "")
        if t == "diff" and ev.get("file") and artifacts.tracked(ev["file"]):  # Claude edited a file in View
            artifacts.snapshot(ev["file"])
        if t == "result":
            pk = self._pick
            if pk and pk.get("phase") == "sent" and (not pk.get("sid") or pk.get("sid") == sid):
                self._pick = None
                if not self._marks_up:
                    self._bg(self._markup, [])
            self._markup_release(float(self.settings["mark_linger"]))
            self._maybe_notify(sid, "Finished" if ev.get("ok") else "Stopped with an error")
            if sid:
                self._worked.add(sid)
        if t == "permission":
            kind = ev.get("kind")
            self._maybe_notify(sid, "Has a question for you" if kind == "question" else "Has a plan for you to check"
                               if kind == "plan" else "Needs your approval: " + str(ev.get("label") or ev.get("tool"))[:100])
        # each check below stands on its own: one event can matter to several of them
        if t in ("result", "compaction") and sid and self.settings.get("keep_notes", True):
            self._bg(self._notes_auto, sid, t == "compaction")
        if t == "context" and sid in self._worked and int(self.settings.get("auto_fresh") or 0) > 0 \
                and (ev.get("totalTokens") or 0) >= int(self.settings["auto_fresh"]):
            self._bg(self._auto_fresh, sid, ev.get("totalTokens") or 0)
        if t in ("job_done", "agent_done") and sid in self._fresh_wanted:  # it waited for this; Claude may reply first
            threading.Timer(5, self._auto_fresh, (sid, 0)).start()
        if t == "context" and ev.get("model") and ev.get("maxTokens"):
            self._remember_limit(ev)
        if t == "fast_unavailable" and ev.get("reason") and self.settings.get("fast_unavailable") != ev["reason"]:
            self.settings["fast_unavailable"] = ev["reason"]
            self._save()
            self._emit({"type": "notice", "level": "info", "sid": sid,
                        "text": f"{ev['reason']}, so Tether hid the Fast button. Settings › Advanced › Fast mode can check again."})
        if self._ready:
            self._outbox.put(ev)

    def _remember_limit(self, ev: dict) -> None:
        """Each model's real window (your settings included), so past sessions show a true meter before they start."""
        key = history.base_model(ev["model"])
        buf = next((c.get("tokens", 0) for c in ev.get("categories") or [] if c.get("kind") == "buffer"), 0)
        new = {"maxTokens": ev["maxTokens"], "buffer": buf, "autocompactSource": ev.get("autocompactSource")}
        limits = self._limits()
        if limits.get(key) != new:
            limits[key] = new
            try:
                LIMITS_FILE.write_text(json.dumps(limits, indent=1))
            except OSError:
                pass

    def _limits(self) -> dict:
        try:
            return json.loads(LIMITS_FILE.read_text())
        except (OSError, ValueError):
            return {}

    def _estimate(self, sid: str) -> dict:
        """Context as of the last saved reply, against that model's known window. Exact numbers replace it once the session runs."""
        tokens, model = history.last_context(sid)
        lim = self._limits().get(history.base_model(model)) if model else None
        if not tokens:
            return {}
        out = {"totalTokens": tokens, "model": model, "estimated": True}
        if lim:
            out.update(maxTokens=lim["maxTokens"], autocompactSource=lim.get("autocompactSource"),
                       categories=[{"name": "Autocompact buffer", "kind": "buffer", "tokens": lim.get("buffer", 0)}])
        return out

    def _maybe_notify(self, sid: str | None, text: str) -> None:
        if not self.settings["notify"] or not sid:
            return
        try:
            focused = bool(self._window and self._window.native and self._window.native.isKeyWindow())
        except Exception:  # noqa: BLE001
            focused = False
        s = self._sessions.get(sid)
        if not focused and s:
            text = re.sub(r"\s*<answers>.*?(</answers>|$)\s*$", "", text or "", flags=re.S)  # the answer-buttons line isn't for reading
            notifier.post(sid, s.title or APP_NAME, text)

    def _notice_clicked(self, sid: str) -> None:
        """You clicked a notification: bring Tether forward on that chat (its newest part, if it started fresh since)."""
        now = next((s.sid for s in list(self._sessions.values()) if sid in recall.lineage(s.sid)), sid)
        s = self._sessions.get(now)
        self._emit({"type": "open_chat", "sid": now, "cwd": s.cwd if s else "", "title": s.title if s else ""})
        self._show_window()

    def _send_loop(self) -> None:
        """Delivers events about every 30 ms, merging runs of text from the same session."""
        while True:
            batch = [self._outbox.get()]
            time.sleep(0.03)
            try:
                while True:
                    batch.append(self._outbox.get_nowait())
            except queue.Empty:
                pass
            merged: list[dict] = []
            for ev in batch:
                last = merged[-1] if merged else None
                if (last and ev["type"] == last["type"] and ev["type"] in ("text_delta", "thinking_delta")
                        and ev.get("sid") == last.get("sid")):
                    merged[-1] = {**last, "text": last["text"] + ev["text"]}
                elif last and ev["type"] == last["type"] in ("level", "usage"):
                    merged[-1] = ev
                else:
                    merged.append(ev)
            try:
                self._window.evaluate_js(f"window.onEvents({json.dumps(merged)})")
            except Exception:  # noqa: BLE001 - window may be closing
                pass

    # ----- sessions -----

    def ready(self):
        self._ready = True
        return {"settings": self.settings, "hotkeys": {k: v[0] for k, v in HOTKEYS.items()},
                "home": str(Path.home()), "mics": voice.input_devices()}

    # Your own names, pins and archive for sessions (kept here, never written into Claude Code's files).
    META_FILE = SUPPORT / "session-meta.json"

    def _meta(self) -> dict:
        try:
            m = json.loads(self.META_FILE.read_text())
        except (OSError, ValueError):
            m = {}
        return {"titles": m.get("titles") or {}, "pinned": m.get("pinned") or [], "archived": m.get("archived") or [],
                "models": m.get("models") or {},  # {sid: [model, effort]}: a reopened chat keeps its own, not the last pick
                "modes": m.get("modes") or {},    # {sid: permission mode} picked in that chat
                "repos": m.get("repos") or {},    # {sid: repo top} picked in the repo menu, when a chat worked in several
                "view": m.get("view") or {},      # {sid: [{path, title}]} files you moved into the View tab
                "switches": m.get("switches") or {}}  # {sid: [{ts, text}]} model and effort changes, shown in the chat

    def set_meta(self, sid, key, value):
        """key: title (text, "" = back to Claude's), pinned (bool), archived (bool), model ([model, effort]), perm_mode (text)."""
        m = self._meta()
        if key == "title":
            if str(value).strip():
                m["titles"][sid] = str(value).strip()[:120]
            else:
                m["titles"].pop(sid, None)
            if sid in self._sessions and str(value).strip():
                self._sessions[sid].title = str(value).strip()[:120]
        elif key == "model":
            m["models"][sid] = list(value)
        elif key == "perm_mode":
            m["modes"][sid] = str(value)
        elif key == "repo":
            m["repos"][sid] = str(value)
        elif key in ("pinned", "archived"):
            ids = [x for x in m[key] if x != sid]
            m[key] = ([sid] + ids) if value else ids
            if key == "archived" and value:
                m["pinned"] = [x for x in m["pinned"] if x != sid]
        SUPPORT.mkdir(parents=True, exist_ok=True)
        self.META_FILE.write_text(json.dumps(m, indent=1))
        return m

    def _pending_fresh(self, items: list[dict]) -> list[dict]:
        """Fresh starts still waiting for their first message: nothing on disk but the carry file, so without this a
        restart loses them (and the pin they took). One that's out of date (you kept going in the old part, or the old
        part already continued elsewhere) is dropped and the pin goes back; the next long reply starts a new one."""
        carry_dir = recall.INDEX_DIR / "carry"
        if not carry_dir.exists():
            return []
        listed = {s["id"]: s for s in items}
        pm = recall.parents_map()
        out = []
        for f in carry_dir.glob("*.md"):
            new, parent = f.stem, pm.get(f.stem)
            if new in listed or new in self._sessions or not parent or parent not in listed:
                continue
            siblings = [c for c, p in pm.items() if p == parent and c != new and c in listed]
            if siblings or history.last_message_time(parent) > f.stat().st_mtime + 1:
                self._drop_fresh(new, parent)
                continue
            out.append({"id": new, "cwd": listed[parent]["cwd"], "branch": "", "title": "Fresh start", "mtime": f.stat().st_mtime,
                        "pending": True})
        return out

    def _drop_fresh(self, new: str, parent: str) -> None:
        m = self._meta()
        if new in m["pinned"]:
            self.set_meta(parent, "pinned", True)
            self.set_meta(new, "pinned", False)
        m = self._meta()
        m["titles"].pop(new, None); m["models"].pop(new, None); m["modes"].pop(new, None); m["repos"].pop(new, None)
        self.META_FILE.write_text(json.dumps(m, indent=1))
        recall.unlink(new)
        (recall.INDEX_DIR / "carry" / f"{new}.md").unlink(missing_ok=True)

    def list_sessions(self):
        """Every recent session, flat, with its folder group and your names, pins and archive applied."""
        items = history.list_sessions(int(self.settings["history_days"]))
        known = {s["id"] for s in items}
        for s in self._sessions.values():  # started here, not on disk yet
            if s.sid not in known:
                items.insert(0, {"id": s.sid, "cwd": s.cwd, "branch": "", "title": s.title or "New session",
                                 "mtime": time.time()})
        items = self._pending_fresh(items) + items
        m = self._meta()
        home = str(Path.home())
        for s in items:
            live = self._sessions.get(s["id"])
            s["status"] = live.status if live else "saved"
            s["title"] = m["titles"].get(s["id"]) or (live.title if live and live.title else s["title"])
            s["renamed"] = s["id"] in m["titles"]
            s["pinned"] = s["id"] in m["pinned"]
            s["archived"] = s["id"] in m["archived"]
            s["scratch"] = history.is_scratch(s["cwd"])
            s["group"] = "Scratch" if s["scratch"] else "Home" if s["cwd"].rstrip("/") == home else Path(s["cwd"]).name
        pm = recall.parents_map()  # {newer part: the part it continues}
        listed = {s["id"] for s in items}
        continued = {p for c, p in pm.items() if c in listed}
        items = [s for s in items if s["id"] not in continued]  # one row per conversation: its newest part
        return {"sessions": items, "pinned": m["pinned"]}

    def part_items(self, sid):
        """An earlier part of a conversation, for scrolling back past a fresh start."""
        return {"items": self._items(sid), "parts": recall.lineage(sid)[1:]}

    def resume_command(self, sid):
        s = self._sessions.get(sid)
        f = history.find_file(sid)
        cwd = s.cwd if s else ""
        if not cwd and f:
            cwd = (history._summary(f) or {}).get("cwd", "")
        cmd = f"cd {json.dumps(cwd)} && claude --resume {sid}" if cwd else f"claude --resume {sid}"
        self.copy(cmd)
        return cmd

    def _session(self, sid: str) -> engine.Session | None:
        return self._sessions.get(sid)

    def open_session(self, sid, cwd, title=""):
        s = self._sessions.get(sid)
        title = self._meta()["titles"].get(sid) or title
        pending = not s and (recall.INDEX_DIR / "carry" / f"{sid}.md").exists() and not history.find_file(sid)
        if not s:
            s = engine.Session(self._emit, cwd, self.settings, sid=sid, resume=not pending, title=title)
            saved = self._meta()["models"].get(sid)
            if sid in self._meta()["modes"]:  # the mode you picked in this chat, not the default for new ones
                s.perm_mode = self._meta()["modes"][sid]
            if saved:
                s.model, s.effort = saved[0], saved[1]
            else:  # opened before Tether kept per-chat models: the model of its last reply, your default effort
                last = history.base_model(history.last_context(sid)[1])
                if last:  # the picker lists short names (opus, haiku…); match the full id the reply recorded
                    s.model = next((m["value"] for m in self.models() if m.get("value") != "default"
                                    and history.base_model(m.get("resolvedModel", "")) == last), last)
            self._sessions[sid] = s
        return {"sid": sid, "cwd": s.cwd, "status": s.status, "model": s.model, "effort": s.effort, "perm_mode": s.perm_mode, "fast": s.fast,
                "items": self._items(sid), "parts": recall.lineage(sid)[1:], "context": s.context_tokens,
                "ctx_usage": s.ctx_usage or (None if pending else self._estimate(sid)), "pending_fresh": pending,
                "jobs": list(s.jobs.values())}

    def job_output(self, sid, task_id, path="", max_bytes=60_000):
        """The newest part of a background job's output file, which Claude Code fills as the job runs (no tokens)."""
        s = self._sessions.get(sid)
        j = (s.jobs.get(task_id) if s else None) or {}
        roots = [Path(f"/tmp/claude-{os.getuid()}"), Path(f"/private/tmp/claude-{os.getuid()}")]
        f = Path(j.get("output_file") or path) if (j.get("output_file") or path) else None
        if not f and task_id and "/" not in task_id:
            f = next((g for r in roots for g in r.glob(f"*/{sid}/tasks/{task_id}.output")), None)
        if not f or f.suffix != ".output" or not any(str(f.resolve()).startswith(str(r.resolve()) + "/") for r in roots if r.exists()):
            return {"text": "", "missing": True}
        try:
            size = f.stat().st_size
            with f.open("rb") as fh:
                fh.seek(max(0, size - max_bytes))
                text = fh.read().decode("utf-8", "replace")
        except OSError:
            return {"text": "", "missing": True}
        if size > max_bytes:
            text = text.split("\n", 1)[-1]
        return {"text": text, "size": size, "cut": size > max_bytes, "path": str(f)}

    def new_session(self, cwd):
        cwd = str(Path(cwd).expanduser())
        if not Path(cwd).is_dir():
            return {"error": f"No folder at {cwd}"}
        s = engine.Session(self._emit, cwd, self.settings)
        self._sessions[s.sid] = s
        return {"sid": s.sid, "cwd": cwd, "status": s.status, "model": s.model, "effort": s.effort, "perm_mode": s.perm_mode, "fast": s.fast, "items": []}

    SIDE_NOTE = ("[Tether side task] This chat is a copy, made so the message below can run alongside the original. "
                 "The original chat is still working on its own task in the same folder: don't continue or redo that task, "
                 "and don't edit files it's changing unless this message needs it.\n\n")

    def fork_session(self, sid, text, images=None):
        """Run separately: a copy of this chat, everything said so far, takes a queued message and runs alongside it."""
        p = self._sessions.get(sid)
        if not p:
            return {"error": "That session isn't open."}
        if not history.find_file(sid):
            return {"error": "This chat isn't saved yet. Try again in a moment."}
        s = engine.Session(self._emit, p.cwd, self.settings, fork_from=sid)
        s.model, s.effort, s.perm_mode, s.fast = p.model, p.effort, p.perm_mode, p.fast
        s.title = (text or "Side task").strip().splitlines()[0][:70]
        self._sessions[s.sid] = s
        self.set_meta(s.sid, "title", s.title)  # its first message is the original's, so the list would show that name
        if s.model:
            self.set_meta(s.sid, "model", [s.model, s.effort])
        if s.perm_mode:
            self.set_meta(s.sid, "perm_mode", s.perm_mode)
        items = self._items(sid)  # what the copy starts from
        try:
            s.send(self.SIDE_NOTE + text, images or [])
        except (OSError, RuntimeError) as exc:
            self._sessions.pop(s.sid, None)
            return {"error": str(exc)}
        return {"sid": s.sid, "cwd": s.cwd, "status": s.status, "model": s.model, "effort": s.effort, "perm_mode": s.perm_mode,
                "fast": s.fast, "title": s.title, "items": items, "parts": recall.lineage(sid)[1:]}

    # ----- side questions (/btw, ⌘/) -----
    # Claude Code's /btw only works in its terminal, so Tether makes its own: a throwaway copy of the chat that isn't
    # saved. It keeps the chat's tools, model and system prompt so the copy reads the chat from the prompt cache
    # (about one short reply's cost) instead of paying for all of it again; a hook refuses every tool call instead.
    SIDEQ_NOTE = ("[Tether side question] The person asks this on the side while the chat goes on; it isn't part of the chat's task. "
                  "Answer only from what's already in this conversation, short and plain. Tools are switched off for this question, "
                  "so don't try any. If the conversation doesn't say, say that in a sentence.\n\n")
    SIDEQ_HOOK = {"hooks": {"PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command":
                  "echo 'Tools are off for a Tether side question. Answer from the conversation.' >&2; exit 2"}]}]}}
    SIDEQ_IDLE = 15 * 60  # an unused copy stops after this; the next question makes a fresh one

    def side_ask(self, sid, qid, text, earlier=None):
        """Ask a side question about this chat. Answers come back as `sideq` events; nothing is added to the chat."""
        p = self._sessions.get(sid)
        if not p:
            return {"error": "That session isn't open."}
        f = history.find_file(sid)
        if not f:
            return {"error": "This chat isn't saved yet. Ask again after its first reply."}
        size = f.stat().st_size
        cur = self._side.get(sid)
        # the chat moved on (or its model changed) since the copy was made: copy it again so the answer is current
        if cur and (not cur["s"].alive or cur["size"] != size or cur["run"] != (p.model, p.effort, p.fast)):
            cur["s"].close()
            cur = None
        prompt = self.SIDEQ_NOTE + "Question: " + str(text or "").strip()
        if not cur:
            if earlier:  # a fresh copy doesn't know the earlier side questions; give it the gist
                past = "\n\n".join(f"Q: {str(x.get('q', ''))[:400]}\nA: {str(x.get('a', ''))[:1200]}" for x in earlier[-4:])
                prompt = self.SIDEQ_NOTE + "Earlier side questions:\n\n" + past + "\n\nQuestion: " + str(text or "").strip()
            cur = {"qid": qid, "size": size, "run": (p.model, p.effort, p.fast), "got": False, "t0": time.time()}
            s = engine.Session(lambda ev, c=cur: self._side_event(sid, c, ev), p.cwd, self.settings, fork_from=sid)
            s.model, s.effort, s.perm_mode, s.fast = p.model, p.effort, p.perm_mode, p.fast
            s.title = "Side question"
            s.extra_settings, s.no_persist = self.SIDEQ_HOOK, True
            cur["s"] = s
            self._side[sid] = cur
        elif cur["s"].status in ("running", "waiting", "starting"):
            return {"error": "Still answering the last side question."}
        cur.update(qid=qid, got=False, t0=time.time(), last=time.time(), waiting=True)
        try:
            cur["s"].send(prompt)
        except (OSError, RuntimeError) as exc:
            self._side.pop(sid, None)
            return {"error": str(exc)}
        print(f"[sideq] {sid[:8]} asked ({'warm copy' if cur.get('n') else 'new copy'})", file=sys.stderr, flush=True)
        cur["n"] = cur.get("n", 0) + 1
        return {"ok": True}

    def _side_event(self, sid, cur, ev):
        t, s = ev.get("type"), cur.get("s")
        out = lambda kind, **kw: self._emit({"type": "sideq", "sid": sid, "qid": cur["qid"], "kind": kind, **kw})
        if t == "text_delta":
            cur["got"] = True
            out("delta", text=ev.get("text", ""))
        elif t == "text_start" and cur["got"]:
            out("delta", text="\n\n")
        elif t == "permission" and s:  # the hook should have stopped it already
            s.answer(ev.get("rid"), "deny", note="Tools are off for a side question. Answer from the conversation.")
        elif t == "result":
            cur["last"], cur["waiting"] = time.time(), False
            out("done", ok=bool(ev.get("ok")), error=ev.get("error") or "", cost=ev.get("cost"), seconds=round(time.time() - cur["t0"], 1))
            print(f"[sideq] {sid[:8]} answered in {time.time() - cur['t0']:.1f}s, cost {ev.get('cost')}", file=sys.stderr, flush=True)
            threading.Timer(self.SIDEQ_IDLE + 5, self._side_idle, args=(sid, cur)).start()
        elif t == "error":
            out("error", text=ev.get("text", ""))
        elif t == "session_state" and ev.get("status") == "exited" and self._side.get(sid) is cur:
            self._side.pop(sid, None)
            if cur.get("waiting") and not cur.get("closing"):
                out("error", text="The side question stopped before it finished.")

    def _side_idle(self, sid, cur):
        if self._side.get(sid) is cur and time.time() - cur.get("last", 0) >= self.SIDEQ_IDLE and cur["s"].status == "idle":
            self.side_close(sid)

    def side_close(self, sid):
        """The popout was closed (or the chat): stop its copy."""
        cur = self._side.pop(sid, None)
        if cur:
            cur["closing"] = True
            cur["s"].close()
        return {"ok": True}

    IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}

    def pick_files(self):
        got = self._window.create_file_dialog(webview.OPEN_DIALOG, allow_multiple=True, directory=str(Path.home()))
        return self._attachments(got or [])

    def _attachments(self, paths):
        """Attach button and files dropped on the window: images under 3.7MB go in as images (the API takes 5MB of
        base64); everything else, and bigger images, go as paths for Claude to open with Read."""
        out = []
        for f in map(Path, paths):
            kind = self.IMAGE_TYPES.get(f.suffix.lower())
            try:
                if kind and f.stat().st_size < 3_700_000:
                    out.append({"data": base64.b64encode(f.read_bytes()).decode(), "media_type": kind, "label": f.name})
                    continue
            except OSError as exc:
                return {"error": f"Couldn't read {f.name}: {exc}"}
            out.append({"path": str(f), "label": f.name})
        return {"files": out}

    def pick_folder(self, start=""):
        got = self._window.create_file_dialog(webview.FOLDER_DIALOG, directory=start or str(Path.home()))
        return got[0] if got else ""

    def default_new_folder_parent(self):
        """Where New folder… made one last time, else ~/Claude Outputs if it exists, else home."""
        for p in (self.settings.get("new_folder_in"), Path.home() / "Claude Outputs"):
            if p and Path(p).is_dir():
                return str(p)
        return str(Path.home())

    def create_folder(self, parent, name):
        name = (name or "").strip()
        if not name:
            return {"error": "Type a folder name."}
        if name in (".", "..") or "/" in name or ":" in name:
            return {"error": "Use a name without / or :."}
        base = Path(parent or Path.home()).expanduser()
        if not base.is_dir():
            return {"error": f"{base} doesn't exist."}
        target = base / name
        if target.exists():
            return {"error": f"{target.name} already exists there."}
        try:
            target.mkdir()
        except OSError as exc:
            return {"error": f"Couldn't create it: {exc.strerror or exc}"}
        if self.settings.get("new_folder_in") != str(base):
            self.settings["new_folder_in"] = str(base)
            self._save()
        return {"path": str(target)}

    def send(self, sid, text, images=None):
        s = self._sessions.get(sid)
        if not s:
            return {"error": "That session isn't open."}
        if self._marks_up:
            self._bg(self._markup, [])
        self._handed.pop(sid, None)  # you kept going here, so this part may hand over again later
        carry = recall.INDEX_DIR / "carry" / f"{sid}.md"
        if carry.exists():  # a fresh start: what it carries over rides along with the first message, no extra turn
            text = carry.read_text() + "\n\n[Your message]\n" + text
        try:
            s.send(text, images or [])
        except (OSError, RuntimeError) as exc:
            return {"error": str(exc)}
        carry.unlink(missing_ok=True)
        return {"ok": True}

    def interrupt(self, sid):
        s = self._sessions.get(sid)
        if s:
            s.interrupt()

    def answer(self, sid, rid, choice, answers=None, note=""):
        s = self._sessions.get(sid)
        if s:
            s.answer(rid, choice, answers, note)

    def set_model(self, sid, model, effort, line="", replace=False):
        s = self._sessions.get(sid)
        if s:
            self._bg(s.restart, model, effort)
        self.set_meta(sid, "model", [model, effort])  # this chat only; new chats use Settings › Sessions
        if line:  # the "Switched to …" line, kept so it's still in the chat after reopening
            m = self._meta()
            lst = m["switches"].setdefault(sid, [])
            if replace and lst:  # several clicks in a row: one line, updated
                lst.pop()
            lst.append({"ts": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", "text": line})
            m["switches"][sid] = lst[-100:]
            self.META_FILE.write_text(json.dumps(m, indent=1))

    def _items(self, sid, n=600):
        return history.transcript(sid, n, self._meta()["switches"].get(sid))

    def _one_stats(self, sid):
        out = dict(history.stats(sid))
        live = getattr(self._sessions.get(sid), "live_cost", None)
        if live and not out.get("error") and (live["usd"] or 0) > ((out.get("cost") or {}).get("usd") or 0):
            # Claude Code writes its cost record to disk later; this session's process reports it after every reply
            out["cost"] = {**(out.get("cost") or {}), "usd": live["usd"],
                           "models": [{"model": k, "usd": v.get("costUSD"), "input": v.get("inputTokens"), "output": v.get("outputTokens"),
                                       "thinking": v.get("thinkingTokens"), "cache_read": v.get("cacheReadInputTokens"),
                                       "cache_write": v.get("cacheCreationInputTokens")}
                                      for k, v in sorted(live["models"].items(), key=lambda kv: -(kv[1].get("costUSD") or 0))]}
        return out

    def session_stats(self, sid):
        """Stats for the whole chat: every session in its chain of fresh starts, added up. Each session keeps its
        own cost record, so the newest one alone would leave out everything before the last fresh start."""
        chain = recall.lineage(sid)
        parts = [(x, self._one_stats(x)) for x in chain]
        saved = [(x, p) for x, p in parts if not p.get("error")]
        if not saved:
            return parts[0][1]
        if len(saved) == 1 and saved[0][0] == sid:
            return saved[0][1]
        newest = saved[0][1]
        add = lambda key: sum(p.get(key) or 0 for _, p in saved)
        def merge(key):
            m: dict = {}
            for _, p in saved:
                for k, n in p.get(key) or []:
                    m[k] = m.get(k, 0) + n
            return sorted(m.items(), key=lambda x: -x[1])
        files: dict = {}
        for _, p in saved:
            for f, n in (p.get("file_edits") or {}).items():
                files[f] = files.get(f, 0) + n
        out = {"id": sid, "first": min(p["first"] for _, p in saved if p.get("first")) if any(p.get("first") for _, p in saved) else "",
               "last": max(p.get("last") or "" for _, p in saved), "turns": add("turns"), "assistant_messages": add("assistant_messages"),
               "tool_errors": add("tool_errors"), "compactions": add("compactions"),
               "last_compaction": max(p.get("last_compaction") or "" for _, p in saved), "context": newest.get("context", 0),
               "tools": merge("tools"), "models": merge("models"), "where": merge("where"),
               "files": [{"path": f, "short": engine.short(f), "edits": n} for f, n in sorted(files.items(), key=lambda x: -x[1])[:15]],
               "files_total": len(files), "size_mb": round(sum(p.get("size_mb") or 0 for _, p in saved), 1),
               "parts": [{"sid": x, "first": p.get("first", ""), "last": p.get("last", ""), "turns": p.get("turns", 0),
                          "usd": (p.get("cost") or {}).get("usd")} for x, p in saved]}
        costs = [p["cost"] for _, p in saved if p.get("cost")]
        if costs:
            models: dict = {}
            for c in costs:
                for m in c.get("models") or []:
                    t = models.setdefault(m["model"], {"model": m["model"]})
                    for k, v in m.items():
                        if k != "model" and v is not None:
                            t[k] = (t.get(k) or 0) + v
            ck = lambda k: sum(c.get(k) or 0 for c in costs) if any(c.get(k) is not None for c in costs) else None
            out["cost"] = {"usd": ck("usd"), "api_ms": ck("api_ms"), "tool_ms": ck("tool_ms"), "wall_ms": ck("wall_ms"),
                           "lines_added": ck("lines_added"), "lines_removed": ck("lines_removed"),
                           "unknown_model_cost": any(c.get("unknown_model_cost") for c in costs), "missing": len(saved) - len(costs),
                           "models": sorted(models.values(), key=lambda m: -(m.get("usd") or 0))}
        return out

    def session_activity(self, sid):
        s = self._sessions.get(sid)
        a = history.activity(sid)
        a["stale"] = bool(s and getattr(s, "stale", False))
        return a

    def reload_session(self, sid):
        """Re-read a session from disk (after it moved on in VS Code or the terminal) and restart its Claude
        process, so the next message continues from there."""
        s = self._sessions.get(sid)
        if not s:
            return {"error": "That session isn't open."}
        if s.status in ("running", "waiting", "starting"):
            return {"error": "It's still working here. Stop it first (Esc), then reload."}
        if s.running_jobs():
            return {"error": "A background job is still running here. Reload once it ends."}
        s.close()
        s.resume = history.find_file(sid) is not None
        s.status = "idle" if s.resume else "new"
        f = history.find_file(sid)
        s.seen_mtime = f.stat().st_mtime if f else 0
        s.stale = False
        title = self._meta()["titles"].get(sid)
        if not title:
            summ = history._summary(f) if f else None
            title = summ["title"] if summ else s.title
        s.title = title
        s._set(s.status)
        return {"sid": sid, "status": s.status, "items": self._items(sid), "title": s.title, "parts": recall.lineage(sid)[1:]}

    def _watch_dock(self) -> None:
        """Twice a second: is any chat working (replying, starting, or a background job)? The Dock icon pulses while one is."""
        from PyObjCTools import AppHelper
        import dock
        was = False
        while True:
            time.sleep(0.5)
            try:
                now = bool(self.settings.get("dock_pulse", True)) and any(
                    s.status in ("running", "starting") or s.busy_work() for s in list(self._sessions.values()))
            except Exception:  # noqa: BLE001
                continue
            if now != was:
                was = now
                AppHelper.callAfter(dock.set_working, now)

    def _watch_files(self) -> None:
        """Every few seconds: has an open session's file grown from somewhere other than this app?"""
        while True:
            time.sleep(3)
            for s in list(self._sessions.values()):
                f = history.find_file(s.sid)
                if not f:
                    continue
                try:
                    m = f.stat().st_mtime
                except OSError:
                    continue
                seen = getattr(s, "seen_mtime", None)
                busy = s.status in ("running", "waiting", "starting") or time.time() - s.last_own < 6
                if seen is None or busy:
                    s.seen_mtime = m
                    continue
                if m > seen + 0.5:
                    s.seen_mtime = m
                    who = history.last_writer(s.sid)
                    if who and who not in ("Tether", "Anvil", "JordCode", "Claude Workbench"):
                        s.stale = True
                        self._emit({"type": "stale", "sid": s.sid, "where": who})

    def set_permission_mode(self, sid, mode):
        if mode not in ("", "auto", "manual", "acceptEdits", "plan", "dontAsk", "bypassPermissions"):
            return
        s = self._sessions.get(sid)
        if s:
            s.set_permission_mode(mode)
        self.set_meta(sid, "perm_mode", mode)  # this chat only, kept across restarts; the default for new ones is in Settings

    def set_fast(self, sid, on):
        s = self._sessions.get(sid)
        if s:
            s.set_fast(bool(on))
        self.settings["fast"] = bool(on)
        self._save()

    def loaded(self, sid, refresh=True):
        """Stats › Loaded in this session: connectors (asked fresh each time, no tokens), skills, plugins, agents.
        Skills and plugins arrive only once a session gets a message, so until then the last ones seen stand in."""
        s = self._sessions.get(sid)
        if not s:
            return {}
        if refresh:  # Stats just opened; the "loaded" event that answers re-reads with refresh off
            self._bg(s.request_loaded, True)
        out = dict(s.loaded)
        cache = SUPPORT / "loaded-cache.json"
        if out.get("skills") is not None:
            try:
                cache.write_text(json.dumps({"skills": out["skills"], "plugins": out["plugins"]}))
            except OSError:
                pass
        else:
            try:
                out.update(json.loads(cache.read_text()))
            except (OSError, ValueError):
                pass
        return out

    def context_usage(self, sid):
        s = self._sessions.get(sid)
        if not s:
            return {}
        try:
            s.request_context(start=True)
        except (OSError, RuntimeError) as exc:
            return {"error": str(exc)}
        return s.ctx_usage or self._estimate(sid)

    # ----- notes and handoffs -----

    _notes_busy: set = set()
    _worked: set = set()        # sessions that finished a reply in this run of Tether (only those roll over)
    _fresh_busy: set = set()    # a fresh start being prepared: one at a time per session, automatic or clicked
    _fresh_lock = threading.Lock()
    _fresh_wanted: set = set()  # passed the limit but had to wait (reply still going, background job running)
    _handed: dict = {}          # session -> the fresh one continuing it, until you message the old one again

    def _claim_fresh(self, sid: str) -> bool:
        with self._fresh_lock:
            if sid in self._fresh_busy:
                return False
            self._fresh_busy.add(sid)
            return True

    def _fresh_blocker(self, sid: str, auto: bool) -> str:
        """Why this session can't hand over right now, or "" if it can. Checked before the notes catch up and again
        just before the switch, so the old session never gets cut off mid-reply or mid-job."""
        if sid in self._handed:
            return "This session already continues in a fresh one."
        s = self._sessions.get(sid)
        if not s:
            return ""  # a past session that isn't running: nothing to cut off
        if s.status in ("running", "waiting", "starting"):
            return "Claude is still working. Start fresh after the reply ends."
        if s.busy_work():
            return "A background job is still running. " + ("Tether starts fresh once it ends." if auto else "Start fresh once it ends.")
        if auto and not history.turn_ended(sid):  # Tether's own status can be wrong; the transcript says for sure
            return "The reply hasn't ended yet."
        return ""

    def _auto_fresh(self, sid: str, tokens: int, tries: int = 0) -> None:
        """Context passed the limit after a reply: catch the notes up, then continue in a fresh session by itself.
        Waits for the reply and any background job to end; whatever it waited for tries again when it's done."""
        s = self._sessions.get(sid)
        if not s or sid in self._handed or int(self.settings.get("auto_fresh") or 0) <= 0:
            return
        tokens = tokens or s.context_tokens
        why = self._fresh_blocker(sid, auto=True)
        if why:
            self._fresh_wanted.add(sid)  # the next reply's context check, or the job ending, tries again
            if why.startswith("The reply") and s.status == "idle" and tries < 3:  # the transcript may lag the reply a moment
                threading.Timer(3, self._auto_fresh, (sid, tokens, tries + 1)).start()
            return
        if not self._claim_fresh(sid):
            return
        try:
            self._emit({"type": "fresh_prep", "sid": sid})
            if notes.pending_chars(sid) > 60_000 or not notes.load(sid)["items"]:
                self.notes_update(sid, wait=True)
            r = self._handoff(sid, auto=True)
            if r.get("error"):
                self._fresh_wanted.add(sid)  # you started another message, or a job began, meanwhile: try after that
            else:
                self._fresh_wanted.discard(sid)
                self._emit({"type": "fresh_start", **r, "auto": True, "context": tokens})
        finally:
            self._fresh_busy.discard(sid)
            self._emit({"type": "fresh_prep", "sid": sid, "done": True})

    def _notes_auto(self, sid: str, force: bool = False) -> None:
        """After a reply: once enough new conversation has piled up (or right after a compaction), fold it into the notes."""
        if sid in self._notes_busy:
            return
        try:
            recall.update(sid)
            if not force and notes.pending_chars(sid) < 25_000:
                return
        except Exception:  # noqa: BLE001 - notes are a nice-to-have; never break the session over them
            return
        self.notes_update(sid)

    def notes_update(self, sid, wait=False):
        if sid in self._notes_busy:
            if not wait:
                return {"busy": True}
            while sid in self._notes_busy:  # a background update is running: let it finish, then read what's left
                time.sleep(0.5)
        def run():
            self._notes_busy.add(sid)
            self._emit({"type": "notes", "sid": sid, "busy": True})
            try:
                r = notes.update(sid, progress=lambda i, n: self._emit({"type": "notes", "sid": sid, "busy": True, "done": i, "of": n}))
            except Exception as exc:  # noqa: BLE001
                r = {"error": str(exc)}
            finally:
                self._notes_busy.discard(sid)
            self._emit({"type": "notes", "sid": sid, "busy": False, **r})
            return r
        if wait:
            return run()
        self._bg(run)
        return {"started": True}

    def carry_text(self, sid):
        """What a fresh start carried over, from its first message (or still waiting to go with the next one)."""
        p = recall.INDEX_DIR / "carry" / f"{sid}.md"
        if p.exists():
            return p.read_text()
        for it in history.transcript(sid, 40):
            if it.get("type") == "user" and it.get("text", "").startswith(("[Tether handoff]", "[Anvil handoff]")):
                return it["text"].split("\n\n[Your message]\n")[0]
        return ""

    def notes_get(self, sid):
        if notes.inherit(sid):
            self.notes_update(sid)  # tidy what came over (repeats, finished to-dos) in the background
        d = notes.load(sid)
        live = [i for i in d["items"] if i.get("status") != "dropped"]
        return {"items": live, "updated": d.get("updated", ""), "cost": d.get("cost", 0.0), "busy": sid in self._notes_busy,
                "sections": notes.SECTIONS, "parents": recall.lineage(sid)[1:]}

    def notes_edit(self, sid, op, value):
        notes.edit(sid, op, value)
        return self.notes_get(sid)

    def handoff(self, sid, auto=False):
        """Start fresh now (the ⋯ menu, the context menu): refused while one is already on its way."""
        why = self._fresh_blocker(sid, auto=False)
        if why:
            return {"error": why}
        if not self._claim_fresh(sid):
            return {"error": "A fresh start for this session is already on its way."}
        try:
            return self._handoff(sid, auto=False)
        finally:
            self._fresh_busy.discard(sid)

    def _handoff(self, sid, auto=False):
        """Start a fresh session that continues this one: its notes, where it left off, and recall into the old history.
        Nothing is sent now: it goes along with your next message in the new session. The caller holds _fresh_busy."""
        old = self._sessions.get(sid)
        cwd = old.cwd if old else next((s["cwd"] for s in history.list_sessions(365) if s["id"] == sid), str(Path.home()))
        title = self._meta()["titles"].get(sid) or (old.title if old else "") or "the previous session"
        self.notes_update(sid, wait=True)
        md, checked = notes.render_fresh(recall.lineage(sid))
        last = history.last_compaction(sid).get("summary", "")
        keep = []
        for name in ("Current Work", "Pending Tasks", "Optional Next Step"):  # the parts of the last summary that say where it was
            m = re.search(rf"\d+\.\s*{name}[^\n]*\n([\s\S]*?)(?=\n\d+\.\s+[A-Z][^\n]*:\s*\n|\Z)", last)
            if m:
                keep.append(f"**{name}**\n{m.group(1).strip()[:2500]}")
        why = self._fresh_blocker(sid, auto)  # again, right before the switch: the notes took a while
        if why:
            return {"error": why}
        tail = history.recent_talk(sid, 40_000) or recall.recent(sid, kinds=("user", "claude"), chars=3500)
        r = self.new_session(cwd)
        if r.get("error"):
            return r
        new = r["sid"]
        recall.link(new, sid)
        if old:  # same model, effort and mode as before
            n = self._sessions[new]
            n.model, n.effort, n.perm_mode, n.fast = old.model, old.effort, old.perm_mode, old.fast
            self.set_meta(new, "model", [n.model, n.effort]); self.set_meta(new, "perm_mode", n.perm_mode)
            r.update(model=n.model, effort=n.effort, perm_mode=n.perm_mode)
        self.set_meta(new, "title", title)
        meta = self._meta()
        if sid in meta["pinned"]:  # the new part takes the old one's place
            self.set_meta(new, "pinned", True); self.set_meta(sid, "pinned", False)
        text = (f"[Tether handoff] This session continues “{title}” ({sid[:8]}). Its notes, where it left off, and the "
                f"recall tool (which searches that session's full history) replace the old context.\n\n"
                f"# Notes\n{md or '(none yet)'}\n\n"
                + (f"# From its last summary\n" + "\n\n".join(keep) + "\n\n" if keep else "")
                + f"# Last messages (the recent stretch, word for word)\n{tail}\n\n"
                "Use recall for anything not here before asking me, and carry on with my message below as if the "
                "conversation had never been cut.\n\n"
                "How to pick up:\n"
                "- \"Latest\", \"most recent\" or \"current\" means the end of the recent stretch above, not an older note.\n"
                "- Before saying something already exists or is done, check the file or ask recall; notes can lag behind.\n"
                "- If my message is a clear go-ahead (\"just run it\", \"exactly\"), act on it instead of asking.\n"
                "- Before changing something, search for everything that depends on it (validators, prompts, docs, tests).")
        carry = recall.INDEX_DIR / "carry"
        carry.mkdir(parents=True, exist_ok=True)
        (carry / f"{new}.md").write_text(text)
        self._handed[sid] = new
        if old and old.status == "idle" and not old.busy_work():  # checked above; one with a job keeps going until you close it
            self._sessions.pop(sid, None)
            old.close()  # the new part takes over; the old one stays in history and in recall
        return {**r, "title": title, "from": sid, "from_title": title, "carry_chars": len(text), "checked": checked}

    # ----- slimming transcripts -----

    def _slim_blocked(self, sid: str, f: Path) -> str:
        s = self._sessions.get(sid)
        if s and s.alive:
            return "It's open in Tether. Close it first (Claude Code could be writing to it)."
        if time.time() - f.stat().st_mtime < 900:
            return "It was written in the last 15 minutes, so it may be open in VS Code or a terminal. Try again later."
        ps = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
        if any(sid in line and "claude" in line for line in ps.splitlines()):
            return "A claude process has it open (VS Code or a terminal). Stop that session first."
        return ""

    def slim_info(self, sid):
        f = history.find_file(sid)
        if not f:
            return {"error": "No transcript found."}
        p = slim.plan(f)
        return {**p, "blocked": self._slim_blocked(sid, f)}

    def slim_session(self, sid, keep_backup=True):
        f = history.find_file(sid)
        if not f:
            return {"error": "No transcript found."}
        why = self._slim_blocked(sid, f)
        if why:
            return {"error": why}
        had_notes = bool(notes.load(sid)["items"])
        if had_notes:
            self.notes_update(sid, wait=True)  # catch the notes up first: the index is rebuilt below
        try:
            r = slim.slim(f, SUPPORT / "slim-backups" if keep_backup else None)
        except (OSError, ValueError) as exc:
            return {"error": f"Stopped, nothing changed: {exc}"}
        # the index remembers byte offsets into the file, which just changed; rebuild it (line numbers are unchanged)
        (recall.INDEX_DIR / f"{sid}.db").unlink(missing_ok=True)
        recall.update(sid)
        if had_notes:
            with notes.txn(sid) as d:
                notes.set_read(d, sid, recall.max_rowid(sid))
        return {**r, "backup": str(SUPPORT / "slim-backups") if keep_backup else ""}

    def agent_trail(self, sid, agent_id):
        return history.agent_trail(sid, agent_id)

    def compaction_summary(self, sid):
        return history.last_compaction(sid)

    def compact(self, sid, focus=""):
        s = self._sessions.get(sid)
        if not s:
            return {"error": "That session isn't open."}
        if s.status in ("running", "waiting", "starting"):
            return {"error": "Wait for Claude to finish, then compact."}
        try:
            s.compact(focus or "")
        except (OSError, RuntimeError) as exc:
            return {"error": str(exc)}
        return {"ok": True}

    def close_session(self, sid):
        self.side_close(sid)
        s = self._sessions.pop(sid, None)
        if s:
            if s.status in ("running", "waiting"):
                s.interrupt()
                time.sleep(0.3)
            s.close()

    def models(self):
        for s in self._sessions.values():
            if s.models:
                return s.models
        cache = SUPPORT / "models.json"
        try:
            return json.loads(cache.read_text())
        except (OSError, ValueError):
            return []

    def _remember_models(self):
        """At startup, ask Claude Code for its model menu (a short-lived `claude -p` initialize), so the picker
        works before any session has started. Cached; refreshed once a day or when a session reports a new list."""
        cache = SUPPORT / "models.json"
        try:
            models = json.loads(cache.read_text())
            fresh = time.time() - cache.stat().st_mtime < 86400
        except (OSError, ValueError):
            models, fresh = [], False
        if models:
            self._emit({"type": "models", "models": models})
        if not fresh:
            got = self._probe_models()
            if got:
                SUPPORT.mkdir(parents=True, exist_ok=True)
                cache.write_text(json.dumps(got))
                self._emit({"type": "models", "models": got})

    def _probe_models(self) -> list:
        binary = engine.find_claude(self.settings.get("claude_path", ""))
        if not binary:
            return []
        env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT")}
        try:
            p = subprocess.Popen([binary, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
                                  "--verbose", "--no-session-persistence"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, cwd=str(Path.home()), env=env)
            p.stdin.write(json.dumps({"type": "control_request", "request_id": "init",
                                      "request": {"subtype": "initialize", "hooks": None}}) + "\n")
            p.stdin.flush()
            timer = threading.Timer(20, p.kill)
            timer.start()
            models = []
            for line in p.stdout:
                e = json.loads(line) if line.strip().startswith("{") else {}
                if e.get("type") == "control_response":
                    models = (e["response"].get("response") or {}).get("models") or []
                    break
            timer.cancel()
            p.kill()
            return models
        except (OSError, ValueError, KeyError):
            return []

    # ----- repos -----

    def discover_repos(self):
        return [{**r, "short": engine.short(r["cwd"])} for r in repos.discover()]

    def repo_status(self, cwd):
        return repos.status(cwd)

    def chat_repos(self, sid, cwd):
        """Repos this chat started in or worked in, across every session in its chain, plus the one you picked."""
        files = [f for f in (history.find_file(x) for x in recall.lineage(sid)) if f]
        found = repos.worked_in(files, cwd)
        chosen = self._meta()["repos"]
        picked = next((chosen[x] for x in recall.lineage(sid) if chosen.get(x)), "")  # a fresh start keeps the pick
        return {"repos": found, "picked": picked if any(r["top"] == picked for r in found) else ""}

    # Changes and History tabs
    VIEWS_FILE = SUPPORT / "repo-views.json"
    VIEW_DEFAULTS = {"scope": "local", "count": 60, "names": True, "remotes": True, "tags": True, "prs": True, "deploys": True,
                     "runs": True, "compact": False, "app": "", "hide_workflows": []}

    def repo_changes(self, cwd):
        return repos.changes(cwd)

    def repo_open_work(self, cwd, fresh=False):
        """Branches and every open PR, for the Changes tab."""
        top = repos.root(cwd)
        if not top:
            return {"git": False}
        fetched = repos.fetch(top, 0 if fresh else 300)
        b = repos.branches(top)
        b["prs"] = repos.open_prs(top, 0 if fresh else 120)
        b["main_status"] = repos.main_status(top)
        b["fetched"] = fetched
        return b

    def repo_view(self, top):
        try:
            saved = json.loads(self.VIEWS_FILE.read_text()).get(top, {})
        except (OSError, ValueError):
            saved = {}
        return {**self.VIEW_DEFAULTS, **saved}

    def repo_view_save(self, top, view):
        try:
            data = json.loads(self.VIEWS_FILE.read_text())
        except (OSError, ValueError):
            data = {}
        data[top] = {k: v for k, v in (view or {}).items() if k in self.VIEW_DEFAULTS}
        self.VIEWS_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.VIEWS_FILE.write_text(json.dumps(data, indent=1))
        return self.repo_view(top)

    def repo_graph(self, cwd, scope="local", count=60):
        return repos.graph(cwd, scope, count)

    def repo_marks(self, cwd, view):
        return repos.marks(cwd, view or {})

    def repo_commit(self, cwd, sha):
        return repos.commit_files(cwd, sha)

    def repo_commit_diff(self, cwd, sha, path):
        return repos.commit_diff(cwd, sha, path)

    def repo_pr(self, cwd, fresh=False):
        return repos.pr(cwd, 0 if fresh else 90)

    def repo_diff(self, cwd, path):
        return repos.diff(cwd, path)

    def repo_log(self, cwd):
        return repos.log(cwd)

    def open_in_editor(self, path, line=0):
        path = str(Path(path).expanduser())
        code = next((c for c in ("/usr/local/bin/code", "/opt/homebrew/bin/code",
                                 "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code") if Path(c).exists()), None)
        if code:
            subprocess.Popen([code, "-g", f"{path}:{int(line or 1)}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            subprocess.Popen(["open", "-a", "Visual Studio Code", path])

    TEXT_EXT = {".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".md", ".txt", ".sql", ".yml", ".yaml", ".toml", ".sh", ".zsh",
                ".css", ".scss", ".ipynb", ".csv", ".tsv", ".log", ".java", ".scala", ".go", ".rs", ".rb", ".kt", ".swift", ".c",
                ".h", ".cpp", ".xml", ".cfg", ".ini", ".lock", ".env", ".r", ".jsonl", ".hl7", ".mjs", ".cjs", ".vue", ".gitignore"}
    IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".bmp", ".tiff", ".svg"}

    def _resolve(self, sid, ref, extra=None):
        """A path from the chat (absolute, ~/, or relative to the session's folder or repo), with any :line or #Lline."""
        ref = str(ref or "").strip().strip("`'\"<>")
        m = re.match(r"^(.*?)(?:#L(\d+)(?:-L?\d+)?|:(\d+)(?::\d+)?(?:-\d+)?)?$", ref)
        raw, line = (m.group(1), int(m.group(2) or m.group(3) or 0)) if m else (ref, 0)
        raw = raw.replace("%20", " ")
        if raw.startswith("file://"):
            raw = raw[7:]
        s = self._sessions.get(sid)
        bases = [s.cwd] + ([repos.root(s.cwd)] if s else []) if s else []
        # Relative names: first the folders the same reply mentioned (e.g. "files are in ~/x/: a.md"), then the session's.
        bases = [str(Path(b).expanduser()) for b in (extra or []) if b] + bases
        cands = [Path(raw).expanduser()] if raw.startswith(("/", "~")) else [Path(b) / raw for b in bases if b]
        for c in cands:
            if c.exists():
                kind = "dir" if c.is_dir() else "image" if c.suffix.lower() in self.IMAGE_EXT else "file"
                return {"kind": kind, "path": str(c), "line": line, "short": engine.short(str(c))}
        return {"kind": "missing", "path": raw, "line": line}

    def path_info(self, sid, ref, bases=None):
        return self._resolve(sid, ref, bases)

    def open_path(self, sid, ref, how="folder"):
        """Click on a path in the chat. how=folder (a click): show it in Finder, in its folder, selected; a folder
        opens. how=editor (⌘-click): files open in VS Code at the line. how=preview: open with the default app."""
        r = self._resolve(sid, ref)
        if r["kind"] == "missing":
            return r
        if how == "file" and r["kind"] == "file":
            # The file itself, in whatever app macOS opens that kind of file with (your choice, in Finder › Get Info).
            subprocess.Popen(["open", r["path"]])
        elif how == "editor" and r["kind"] == "file":
            self.open_in_editor(r["path"], r["line"])
        elif r["kind"] == "dir" or how == "preview":
            subprocess.Popen(["open", r["path"]])
        else:
            subprocess.Popen(["open", "-R", r["path"]])
        return r

    def image_data(self, sid, ref):
        r = self._resolve(sid, ref)
        if r["kind"] != "image":
            return None
        p = Path(r["path"])
        if p.stat().st_size > 12_000_000:
            return None
        mime = {"jpg": "jpeg", "svg": "svg+xml", "tif": "tiff"}.get(p.suffix.lower()[1:], p.suffix.lower()[1:])
        return {"src": f"data:image/{mime};base64," + base64.b64encode(p.read_bytes()).decode(), "short": r["short"]}

    def preview(self, sid, ref):
        """The popout beside a path, tool row or attachment: the image, or the text of the file (first 3,000 lines)
        with the line it points at. Binary and huge files say so and keep the Open button."""
        r = self._resolve(sid, ref)
        if r["kind"] in ("missing", "dir"):
            return r
        p = Path(r["path"])
        if r["kind"] == "image":
            return {**r, **(self.image_data(sid, r["path"]) or {"kind": "big"})}
        try:
            size = p.stat().st_size
            raw = p.open("rb").read(2_000_000)
        except OSError as exc:
            return {"kind": "missing", "path": r["path"], "error": str(exc)}
        if b"\0" in raw[:8000]:
            return {**r, "kind": "binary", "size": size}
        lines = raw.decode("utf-8", "replace").split("\n")
        if size > len(raw):
            lines = lines[:-1]  # cut mid-line
        return {**r, "kind": "text", "lines": lines[:3000], "total": len(lines), "size": size}

    # ----- the View tab: artifacts Claude shows, and files you open there -----

    def _view_opened(self, sid) -> list[dict]:
        m = self._meta()
        out, seen = [], set()
        for x in recall.lineage(sid):
            for it in m["view"].get(x, []):
                if it.get("path") not in seen:
                    seen.add(it.get("path")); out.append(it)
        return out

    @staticmethod
    def _shelf_name(path: str, title: str = "") -> str:
        """What the Shelf calls an item: Claude's title, else the file name; an index page goes by its folder."""
        p = Path(path)
        if title and title != p.name:
            return title
        return p.parent.name if p.stem.lower() == "index" and p.parent.name else p.name

    def view_list(self, sid):
        """Artifacts from every session in this chat, oldest first, then the files you opened here. Each has "ts",
        when it was last shown or opened, so the Shelf can keep older ones under Earlier."""
        arts, seen = [], set()
        for x in reversed(recall.lineage(sid)):
            for a in history.artifacts_in(x):
                if a["path"] in seen:
                    arts = [b for b in arts if b["path"] != a["path"]]
                seen.add(a["path"])
                try:
                    ts = datetime.datetime.fromisoformat(str(a.get("ts")).replace("Z", "+00:00")).timestamp()
                except ValueError:
                    ts = history.last_message_time(x)
                arts.append({**a, "from": "claude", "type": artifacts.kind(a["path"]), "title": self._shelf_name(a["path"], a.get("title") or ""), "ts": ts})
        m, opened = self._meta(), []
        for x in recall.lineage(sid):  # opened before times were kept: the session it was opened in stands in
            for it in m["view"].get(x, []):
                if it.get("path") in seen:
                    continue
                seen.add(it["path"])
                opened.append({**it, "short": engine.short(it["path"]), "from": "you", "type": artifacts.kind(it["path"]),
                               "title": self._shelf_name(it["path"], it.get("title") or ""), "ts": it.get("ts") or history.last_message_time(x)})
        here = [x for x in arts + opened if Path(str(x.get("path", ""))).expanduser().exists()]  # deleted or moved: off the list
        return {"items": here}

    def shelf_recent(self, sid):
        """The Shelf's "Other chats": what Claude showed lately in other chats, newest first, with each chat's name."""
        mine, titles, names, out = set(recall.lineage(sid)), self._meta()["titles"], {}, []
        for a in artifacts.recent():
            if a["sid"] in mine:
                continue
            if a["sid"] not in names:
                f = history.find_file(a["sid"])
                names[a["sid"]] = titles.get(a["sid"]) or ((history._summary(f) or {}).get("title") if f else "") or "Another chat"
            out.append({"path": a["path"], "short": engine.short(a["path"]), "title": a["title"] or Path(a["path"]).name,
                        "type": artifacts.kind(a["path"]), "chat": names[a["sid"]], "from": "shelf"})
            if len(out) >= 12:
                break
        return {"items": out}

    def view_open(self, sid, ref, on=True, title=""):
        """Keep a file in this chat's View tab (on), or take it out."""
        r = self._resolve(sid, ref)
        path = r.get("path") or str(ref)
        m = self._meta()
        for x in recall.lineage(sid):
            m["view"][x] = [it for it in m["view"].get(x, []) if it.get("path") != path]
        if on:
            m["view"].setdefault(sid, []).append({"path": path, "title": title or Path(path).name, "ts": time.time()})
        m["view"] = {k: v for k, v in m["view"].items() if v}
        self.META_FILE.write_text(json.dumps(m, indent=1))
        return {"path": path, "short": engine.short(path), "type": artifacts.kind(path), "title": title or Path(path).name}

    def view_stat(self, path):
        try:
            st = Path(path).expanduser().stat()
            return {"mtime": st.st_mtime, "size": st.st_size}
        except OSError:
            return {"missing": True}

    def view_get(self, sid, path, base=0, n=0):
        """One View item: the sealed page, the text or the image; its versions; and, for text, the lines changed
        since version `base`. n picks an older version to look at instead of the file as it is now."""
        p = Path(path).expanduser()
        t = artifacts.kind(path)
        out = {"path": str(p), "short": engine.short(str(p)), "type": t}
        if not p.is_file():
            return {**out, "missing": True, "moved_to": artifacts.moved_to(path)}  # no versions: nothing to restore over
        st = p.stat()
        out["mtime"], out["size"] = st.st_mtime, st.st_size
        if t == "image":
            return {**out, **(self.image_data(sid, str(p)) or {"big": True})}
        cur = artifacts.snapshot(str(p))
        vs = artifacts.versions(str(p))
        out["versions"] = [{"n": v["n"], "ts": v["ts"], "note": v.get("note", "")} for v in vs]
        out["n"] = cur["n"] if cur else 0
        data = artifacts.read_version(str(p), n) if n else None
        if n and data is None:
            return {**out, "error": "That version is no longer kept."}
        out["shown"] = n or out["n"]
        if t in ("page", "svg"):
            out["html"] = artifacts.sealed_html(str(p), data, libs=False)  # the window fills in chart and diagram libraries
            return out
        raw = data if data is not None else p.open("rb").read(2_000_000)
        if b"\0" in raw[:8000]:
            return {**out, "binary": True}
        out["text"] = raw.decode("utf-8", "replace")
        out["cut"] = data is None and st.st_size > len(raw)
        if base and not n and cur and base < cur["n"]:
            out["changes"] = artifacts.changes(str(p), base)
        return out

    def view_restore(self, path, n):
        return artifacts.restore(path, n)

    def lib_source(self, name):
        """A bundled chart or diagram library (ui/lib), fetched once by the window to fill Shelf pages and draw diagrams."""
        return artifacts.lib_source(name)

    def note_shot(self, path, width, vh, pins, color="", dark=False):
        """The picture that goes with your notes on a Shelf page: the page at the size you saw it, with numbered pins."""
        r = artifacts.look(path, max(320, min(1600, int(width or 600))), {"vh": vh, "pins": pins, "color": color}, bool(dark))
        return {"data": r["jpeg"], "media_type": "image/jpeg"} if r.get("jpeg") else {"error": r.get("error") or "Couldn't draw the page."}

    def permissions(self):
        """What macOS has switched off that a setting needs, for the lines under it in Settings."""
        try:
            import Quartz
            screen = bool(Quartz.CGPreflightScreenCaptureAccess())
        except Exception:  # noqa: BLE001
            screen = True
        return {"screen": screen, "notify_off": notifier.turned_off()}

    def open_mac_settings(self, which):
        url = {"notifications": "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=local.tether",
               "screen": "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture"}.get(which)
        if url:
            subprocess.Popen(["open", url])

    # ----- report a problem: a GitHub issue the user reads and submits in the browser -----
    REPORT_REPO = "https://github.com/jfroy525/tether"

    def report_info(self, sid="", error=""):
        """Title and body for an issue: versions, the chat's model, the error and the end of Tether.log, with the
        user's home folder and name swapped for ~ and <user>. Chat text, files and pictures are never included."""
        import platform
        home, user = str(Path.home()), Path.home().name

        def scrub(t: str) -> str:
            return re.sub(rf"\b{re.escape(user)}\b", "<user>", str(t).replace(home, "~")) if user else str(t)
        git = lambda *a: repos._run(["git", *a], str(Path(__file__).resolve().parent), 10)[1].strip()  # noqa: E731
        try:
            cv = subprocess.run([engine.find_claude(self.settings.get("claude_path", "")) or "claude", "--version"],
                                capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            cv = "not found"
        S = self._sessions.get(sid)
        log = Path.home() / "Library/Logs/Tether.log"
        try:
            tail = log.read_text(errors="replace").splitlines()[-40:]
        except OSError:
            tail = []
        tail = [l[:300] for l in tail]
        rows = [f"- Tether: {git('log', '-1', '--format=%h · %cs') or 'unknown'}",
                f"- macOS: {platform.mac_ver()[0] or 'unknown'} ({platform.machine()})",
                f"- Claude Code: {cv or 'unknown'}"]
        if S:
            rows.append(f"- Chat model: {S.model or 'default'} · status {S.status}")
        err = scrub(error).strip()
        body = ("**What happened**\n\n(Describe what you were doing.)\n\n"
                + (f"**Error**\n\n```\n{err}\n```\n\n" if err else "")
                + "**Details**\n\n" + "\n".join(rows) + "\n\n"
                + "**End of Tether.log**\n\n```\n" + scrub("\n".join(tail)) + "\n```\n")
        title = (err.splitlines()[0][:90] if err else "Problem report")
        return {"title": title, "body": body}

    def open_report(self, title, body):
        """Open GitHub's new-issue page with these filled in; GitHub caps the address, so the body is trimmed."""
        body = str(body)
        while True:
            url = f"{self.REPORT_REPO}/issues/new?" + urllib.parse.urlencode({"title": str(title)[:200], "body": body})
            if len(url) <= 7800 or len(body) < 200:
                break
            body = "(trimmed to fit)\n" + body[-int(len(body) * 0.8):]
        subprocess.Popen(["open", url])
        return True

    def open_url(self, url):
        if re.match(r"^https?://", str(url)):
            subprocess.Popen(["open", url])

    def reveal(self, path):
        subprocess.Popen(["open", "-R", str(Path(path).expanduser())])

    # ----- tables -----

    def export_table(self, title, columns, rows):
        EXPORTS.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^\w-]+", "-", (title or "results").lower()).strip("-")[:50] or "results"
        path = EXPORTS / f"{time.strftime('%Y-%m-%d-%H%M')}-{name}.csv"
        with path.open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(columns)
            w.writerows(rows)
        subprocess.Popen(["open", "-R", str(path)])
        return engine.short(str(path))

    def copy(self, text):
        subprocess.run(["pbcopy"], input=str(text).encode(), check=False)

    # ----- screen: attach a window, circle to explain, Claude's marks -----

    def windows(self):
        if not screen.allowed(ask=True):
            return {"error": screen.PERMISSION_HELP}
        return {"windows": [{"id": w["id"], "app": w["app"], "title": w["title"][:80], "visible": w["visible"]}
                            for w in screen.list_windows()[:40]]}

    def capture(self, what="window", window=""):
        ok, err, parts = screen.capture(what, str(window))
        if not ok:
            return {"error": err}
        out = []
        for p in parts:
            out.append({"data": base64.b64encode(Path(p["path"]).read_bytes()).decode(), "media_type": "image/jpeg",
                        "label": p["label"]})
            Path(p["path"]).unlink(missing_ok=True)
        return {"images": out}

    def _markup(self, marks: list) -> None:
        if not self._overlays:
            return
        if marks and self._pick and self._pick.get("phase") == "sent":
            self._pick = None
        groups = screen.place_marks(marks)[:len(self._overlays)]
        if self._overlay_hide:
            self._overlay_hide.cancel()
        self._mark_gen += 1
        gen = self._mark_gen
        self._marks_up = bool(groups)
        for i in self._shown - set(range(len(groups))):
            self._js_overlay(i, "window.clearMarks && clearMarks()")
            threading.Timer(1.0, self._overlay_out, args=(i, gen)).start()
        self._shown = set(range(len(groups)))
        if not groups:
            return
        from PyObjCTools import AppHelper
        main_h = screen.main_display_height()
        spots = [{} for _ in groups]
        for i, (display, _placed) in enumerate(groups):
            AppHelper.callAfter(self._overlay_in, i, display, main_h, spots[i])
        time.sleep(0.15)
        for i, (_display, placed) in enumerate(groups):
            dx, dy = spots[i].get("dx", 0.0), spots[i].get("dy", 0.0)
            for m in placed:
                for k in ("x", "x2"):
                    if k in m:
                        m[k] -= dx
                for k in ("y", "y2"):
                    if k in m:
                        m[k] -= dy
                if "points" in m:
                    m["points"] = [[a - dx, b - dy] for a, b in m["points"]]
            self._js_overlay(i, f"draw({json.dumps(placed)})")

    def _markup_release(self, seconds: float) -> None:
        if not self._marks_up or seconds <= 0:
            return
        if self._overlay_hide:
            self._overlay_hide.cancel()
        self._overlay_hide = threading.Timer(seconds, self._markup, args=([],))
        self._overlay_hide.start()

    def clear_marks(self):
        self._bg(self._markup, [])

    def marks_up(self):
        return self._marks_up

    def _js_overlay(self, i: int, js: str) -> None:
        try:
            self._overlays[i].evaluate_js(js)
        except Exception:  # noqa: BLE001
            pass

    def _overlay_in(self, i: int, d: dict, main_h: float, where: dict, interactive: bool = False) -> None:
        """Main thread: cover that display, above everything, without taking focus."""
        import AppKit
        win = self._overlays[i].native
        if win is None:
            return
        win.setStyleMask_(AppKit.NSWindowStyleMaskBorderless)
        win.setFrame_display_(AppKit.NSMakeRect(d["x"], main_h - (d["y"] + d["h"]), d["w"], d["h"]), True)
        win.setAlphaValue_(1.0)
        f = win.frame()
        where["dx"] = f.origin.x - d["x"]
        where["dy"] = (main_h - (f.origin.y + f.size.height)) - d["y"]
        win.setIgnoresMouseEvents_(not interactive)
        win.setLevel_(AppKit.NSScreenSaverWindowLevel)
        win.setHasShadow_(False)
        win.setCollectionBehavior_(AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
                                   | AppKit.NSWindowCollectionBehaviorStationary
                                   | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
                                   | AppKit.NSWindowCollectionBehaviorIgnoresCycle)
        win.orderFrontRegardless()

    def _overlay_out(self, i: int, gen: int) -> None:
        if gen != self._mark_gen and i in self._shown:
            return
        from PyObjCTools import AppHelper

        def hide():
            # Not orderOut_: taking this window off screen makes the app quit. Invisible and one pixel instead.
            import AppKit
            win = self._overlays[i].native
            if win is not None:
                win.setAlphaValue_(0.0)
                win.setFrame_display_(AppKit.NSMakeRect(0, 0, 1, 1), False)
        AppHelper.callAfter(hide)

    def pick_color(self):
        """Pick a color from the screen: the Mac's own magnifier (no Screen Recording needed); the hex code goes in the
        message box. Esc cancels."""
        import AppKit
        from PyObjCTools import AppHelper

        def done(color):
            self._sampler = None
            if color is None:
                return
            c = color.colorUsingColorSpace_(AppKit.NSColorSpace.sRGBColorSpace())
            if c is None:
                return self._emit({"type": "screen_color", "error": "Couldn't read that color."})
            hx = "#" + "".join(f"{max(0, min(255, round(v * 255))):02X}" for v in (c.redComponent(), c.greenComponent(), c.blueComponent()))
            self._emit({"type": "screen_color", "hex": hx})

        def show():
            self._sampler = AppKit.NSColorSampler.alloc().init()  # kept until it answers
            self._sampler.showSamplerWithSelectionHandler_(done)
        AppHelper.callAfter(show)

    def start_circle(self, mode="circle"):
        """mode "circle": draw on the screen to ask about it. "text": drag a box and its text goes in the message box.
        "lift": drag a box over a table and it opens on the Shelf (lift.py). "window": windows light up under the
        pointer; click one and a prompt box opens over it, and Claude marks that window up (window_pick, window_ask)."""
        if not self._overlays:
            return
        if not screen.allowed(ask=True):
            self._emit({"type": "notice", "level": "error", "text": screen.PERMISSION_HELP})
            return
        from PyObjCTools import AppHelper
        if self._overlay_hide:
            self._overlay_hide.cancel()
        self._mark_gen += 1
        self._circle_displays = screen.displays()[:len(self._overlays)]
        self._circle_mode = mode
        main_h = screen.main_display_height()
        self._circle_spots = [{} for _ in self._circle_displays]
        for i, d in enumerate(self._circle_displays):
            AppHelper.callAfter(self._overlay_in, i, d, main_h, self._circle_spots[i], True)
        time.sleep(0.15)
        self._pick = None
        for i in range(len(self._circle_displays)):
            hint = json.dumps("Drag over a table or chart" if mode == "lift" else "Drag over the text you want")
            self._js_overlay(i, f"grab(true, {i}, {hint})" if mode in ("text", "lift") else
                             f"pick(true, {i})" if mode == "window" else f"lasso(true, {i})")
        self._shown = set(range(len(self._circle_displays)))
        self._emit({"type": "circling", "on": True})
        if mode == "window":
            self._pick = {"phase": "hover", "stack": screen.window_stack(), "hover": None, "token": self._mark_gen}
            self._bg(self._pick_loop, self._mark_gen)

    def circle_cancel(self):
        if self._pick:
            self._pick = None
            self._pick_focus(None)
            self._circle_displays = self._circle_displays or [None]
        if self._circle_displays:
            self._circle_displays = None
            self._bg(self._markup, [])
        self._emit({"type": "circling", "on": False})

    # ----- mark up a window -----

    def _pick_loop(self, token) -> None:
        """Follow the pointer (the overlays don't get mouse moves until they're key) and light up the window under it.
        Only a change of window is sent to the overlays; they glide the glow there."""
        import AppKit
        main_h = screen.main_display_height()
        last, n = "", 0
        while self._pick and self._pick.get("token") == token and self._pick.get("phase") == "hover":
            n += 1
            if n % 40 == 0:  # windows can move or open while you look around
                try:
                    self._pick["stack"] = screen.window_stack()
                except Exception:  # noqa: BLE001
                    pass
            p = AppKit.NSEvent.mouseLocation()
            x, y = p.x, main_h - p.y
            hit = next((w for w in self._pick["stack"]
                        if w["x"] <= x < w["x"] + w["w"] and w["y"] <= y < w["y"] + w["h"]), None)
            if hit and hit["ours"]:
                hit = None
            key = str(hit["id"]) if hit else ""
            if key != last:
                last = key
                self._pick["hover"] = hit
                name = (f"{hit['app']} · {hit['title']}" if hit["title"] and hit["title"] != hit["app"] else hit["app"]) if hit else ""
                for j, d in enumerate(self._circle_displays or []):
                    spot = self._circle_spots[j]
                    r = ({"x": hit["x"] - d["x"] - spot.get("dx", 0.0), "y": hit["y"] - d["y"] - spot.get("dy", 0.0),
                          "w": hit["w"], "h": hit["h"], "name": name} if hit else None)
                    self._js_overlay(j, f"pickHover({json.dumps(r)})")
            time.sleep(0.03)

    def _pick_focus(self, i) -> None:
        """Let overlay i take the keyboard so you can type in its prompt box (None gives it back to Tether)."""
        from PyObjCTools import AppHelper

        def go():
            import AppKit
            try:
                for j, o in enumerate(self._overlays):
                    win = o.native
                    if win is None:
                        continue
                    win.focus = j == i  # pywebview's window says it can take the keyboard when this is on
                    if j == i:
                        win.makeKeyWindow()
                        app = AppKit.NSApplication.sharedApplication()
                        if not app.isActive():
                            app.activateIgnoringOtherApps_(True)
                            win.makeKeyWindow()
                if i is None and self._window and self._window.native and AppKit.NSApplication.sharedApplication().isActive():
                    self._window.native.makeKeyWindow()
            except Exception:  # noqa: BLE001 - the prompt box just won't take typing
                pass
        AppHelper.callAfter(go)

    def window_pick(self, i):
        """A click on a lit window: its overlay keeps the glow and opens the prompt box; the others step aside."""
        pk = self._pick
        if not pk or pk.get("phase") != "hover" or not pk.get("hover"):
            return False
        pk["phase"], pk["win"], pk["idx"] = "ask", pk["hover"], int(i)
        for j in range(len(self._circle_displays or [])):
            if j != int(i):
                self._js_overlay(j, "pick(false)")
                self._overlay_out(j, self._mark_gen)
        self._shown = {int(i)}
        self._pick_focus(int(i))
        return True

    def window_ask(self, i, text):
        self._bg(self._window_ask_safely, int(i), str(text or "").strip())

    def _window_ask_safely(self, i, text) -> None:
        try:
            self._window_ask(i, text)
        except Exception as exc:  # noqa: BLE001
            self._pick = None
            self._circle_displays = None
            self._pick_focus(None)
            self._markup([])
            self._emit({"type": "circling", "on": False})
            self._emit({"type": "notice", "level": "error", "text": f"Mark up a window failed: {exc}"})

    def _window_ask(self, i, text) -> None:
        pk = self._pick
        if not pk or pk.get("phase") != "ask":
            return
        win = pk["win"]
        pk["phase"] = "sent"
        self._circle_displays = None
        from PyObjCTools import AppHelper

        def step_aside():  # the pill stays, but clicks go through, and the picked app comes to the front for the marks
            import AppKit
            for o in self._overlays:
                if o.native is not None:
                    o.native.focus = False
                    o.native.setIgnoresMouseEvents_(True)
            app = AppKit.NSApplication.sharedApplication()
            other = AppKit.NSRunningApplication.runningApplicationWithProcessIdentifier_(win["pid"])
            if other is not None:
                try:
                    app.yieldActivationToApplication_(other)
                except Exception:  # noqa: BLE001 - before macOS 14
                    pass
                other.activateWithOptions_(AppKit.NSApplicationActivateIgnoringOtherApps)
        AppHelper.callAfter(step_aside)
        time.sleep(0.35)
        ok, err, parts = screen.capture_picked(win)
        self._emit({"type": "circling", "on": False})
        if not ok:
            self._pick = None
            self._markup([])
            self._emit({"type": "notice", "level": "error", "text": err})
            return
        p = parts[0]
        images = [{"data": base64.b64encode(Path(p["path"]).read_bytes()).decode(), "media_type": "image/png"
                   if p["path"].endswith(".png") else "image/jpeg", "label": p["label"]}]
        Path(p["path"]).unlink(missing_ok=True)
        where = p["label"] + ("" if p["markable"] else " (it's partly behind other windows, so describe where things are)")
        ask = text or "Point out anything worth a look."
        self._emit({"type": "window_marked", "images": images,
                    "text": f"Mark up {where} on my screen: {ask}"})
        token = self._mark_gen
        t = threading.Timer(180, lambda: self._pick and self._mark_gen == token and self.circle_cancel())  # never a stuck pill
        t.daemon = True
        t.start()

    def window_ask_sent(self, sid):
        if self._pick and self._pick.get("phase") == "sent":
            self._pick["sid"] = sid

    def circle_key(self, key):
        """Return or Esc in the app window while drawing (the overlays never take the keyboard)."""
        if self._circle_displays:
            for i in range(len(self._circle_displays)):
                self._js_overlay(i, "finishLasso()" if key == "Enter" else "cancelLasso()")

    def circle_done(self, i, points):
        self._bg(self._circled_safely, i, points)

    def _circled_safely(self, i, points) -> None:
        """If anything goes wrong, never leave the drawing overlay over the user's screen."""
        try:
            self._circled(i, points)
        except Exception as exc:  # noqa: BLE001
            self._circle_displays = None
            self._markup([])
            self._emit({"type": "circling", "on": False})
            self._emit({"type": "notice", "level": "error", "text": f"Circle to explain failed: {exc}"})

    def _circled(self, i, points) -> None:
        displays = self._circle_displays
        if not displays or not points:
            return
        self._circle_displays = None
        i = int(i)
        d, spot = displays[i], self._circle_spots[i]
        flat = [p for stroke in points for p in stroke] if isinstance(points[0][0], list) else points
        xs = [float(p[0]) + spot.get("dx", 0.0) for p in flat]
        ys = [float(p[1]) + spot.get("dy", 0.0) for p in flat]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        if x1 - x0 < 14 and y1 - y0 < 14:  # a click, not a ring: take the area around it
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            x0, y0, x1, y1 = cx - 120, cy - 80, cx + 120, cy + 80
        region = {"x": d["x"] + x0, "y": d["y"] + y0, "w": x1 - x0, "h": y1 - y0}
        from PyObjCTools import AppHelper
        for j in range(len(displays)):
            if j != i:
                self._js_overlay(j, "lasso(false)")
                self._overlay_out(j, self._mark_gen)
        AppHelper.callAfter(lambda: self._overlays[i].native and self._overlays[i].native.setIgnoresMouseEvents_(True))
        self._shown, self._marks_up = {i}, True
        time.sleep(0.25)
        ok, err = screen.capture_circled(d["n"], region)
        parts = screen.take_circled() if ok else []
        self._emit({"type": "circling", "on": False})
        if not parts:
            self._emit({"type": "notice", "level": "error", "text": err or "Couldn't take the screenshot."})
            return
        images = []
        for p in parts:
            images.append({"data": base64.b64encode(Path(p["path"]).read_bytes()).decode(), "media_type": "image/jpeg",
                           "label": p["label"]})
            Path(p["path"]).unlink(missing_ok=True)
        self._markup_release(4)  # the ring fades soon; Claude's own marks replace it
        self._show_window()
        self._emit({"type": "circled", "images": images})

    def text_done(self, i, rect):
        self._bg(self._grabbed_safely, i, rect)

    def _grabbed_safely(self, i, rect) -> None:
        try:
            self._grabbed(i, rect)
        except Exception as exc:  # noqa: BLE001
            self._circle_displays = None
            self._markup([])
            self._emit({"type": "circling", "on": False})
            self._emit({"type": "notice", "level": "error", "text": f"Copy text from the screen failed: {exc}"})

    def _grabbed(self, i, rect) -> None:
        """Copy text from the screen: the box the user dragged (overlay points) is read on this Mac."""
        displays = self._circle_displays
        if not displays or not rect:
            return
        self._circle_displays = None
        i = int(i)
        d, spot = displays[i], self._circle_spots[i]
        x, y, w, h = (float(v) for v in rect)
        region = {"x": d["x"] + x + spot.get("dx", 0.0), "y": d["y"] + y + spot.get("dy", 0.0), "w": w, "h": h}
        from PyObjCTools import AppHelper
        for j in range(len(displays)):
            if j != i:
                self._js_overlay(j, "lasso(false)")
        AppHelper.callAfter(lambda: [o.native and o.native.setIgnoresMouseEvents_(True) for o in self._overlays])
        time.sleep(0.2)  # the overlay is clear by now; let it repaint before the screenshot
        if getattr(self, "_circle_mode", "") == "lift":
            got = lift.lift(d["n"], region)
            self._markup([])
            self._emit({"type": "circling", "on": False})
            self._show_window()
            if got.get("picture"):  # no table to read (a chart): Claude gets the picture instead
                pic = Path(got["picture"])
                got = {"image": {"data": base64.b64encode(pic.read_bytes()).decode(), "media_type": "image/png", "label": "boxed on screen"}}
                pic.unlink(missing_ok=True)
            self._emit({"type": "lifted", **got})
            return
        text, err = screen.read_text(d["n"], region)
        self._markup([])
        self._emit({"type": "circling", "on": False})
        self._show_window()
        self._emit({"type": "screen_text", "text": text, "error": err or ("" if text else "No text found in that box.")})

    # ----- voice -----

    def mic(self, on):
        self._bg(self._voice_down if on else self._voice_up)

    def _voice_down(self) -> None:
        try:
            self._dictation.start(self.settings["mic"])
            self._emit({"type": "dictating", "on": True})
        except Exception as exc:  # noqa: BLE001
            self._emit({"type": "notice", "level": "error", "text": f"Couldn't use the microphone: {exc}"})

    def _voice_up(self) -> None:
        if not self._dictation.recording:
            return
        self._emit({"type": "dictating", "on": False, "busy": True})
        try:
            text = self._dictation.stop(self.settings["whisper_model"], self.settings["vocabulary"])
        except Exception as exc:  # noqa: BLE001
            self._emit({"type": "notice", "level": "error", "text": f"Couldn't transcribe: {exc}"})
            text = ""
        self._emit({"type": "dictation", "text": text, "send": bool(self.settings["auto_send_dictation"])})

    # ----- the window -----

    def set_look(self, dark, transparency=55, frost=50):
        """The desktop blur follows the page's theme (not only the system's); transparency 0 turns it off.
        Transparency fades the material's own tint past 55; frost sets the blur radius (0–60, 30 is macOS's own).
        AppKit rebuilds these layers on theme changes and sometimes on focus, so they're set again each time."""
        from PyObjCTools import AppHelper
        try:
            Path(os.environ.get("TETHER_LOOK") or SUPPORT / "look.json").write_text(json.dumps({"dark": bool(dark)}))
        except OSError:
            pass
        t, f = float(transparency or 0), float(50 if frost is None else frost)
        tint = 1.0 if t <= 55 else max(0.1, 1 - 0.9 * (t - 55) / 45)

        def layers():
            try:
                import AppKit
                for v in self._window.native.contentView().subviews():
                    if isinstance(v, AppKit.NSVisualEffectView):
                        v.setHidden_(t <= 0)
                        v.setAlphaValue_(1.0)
                        _glass_layers(v.layer(), f * 0.6, tint)
            except Exception:  # noqa: BLE001 - cosmetic
                pass

        def apply():
            try:
                import AppKit
                n = self._window.native
                n.setAppearance_(AppKit.NSAppearance.appearanceNamed_("NSAppearanceNameDarkAqua" if dark else "NSAppearanceNameAqua"))
                getattr(glass_window, "keep", lambda: None)()  # a new appearance lays the traffic lights out again
            except Exception:  # noqa: BLE001 - cosmetic
                pass
            layers()
            for later in (0.15, 0.6, 1.5):  # the new appearance's layers arrive a moment later
                AppHelper.callLater(later, layers)
        glass_window.layers = layers
        AppHelper.callAfter(apply)

    def backdrop(self, cols=64, rows=40):
        """What's behind the window (not the window itself), as a cols×rows grid of relative luminance 0–1, top row
        first. Glass panes use it to pick light or dark text. Needs Screen Recording; without it, {"error"}."""
        try:
            import AppKit
            import Quartz
            if not Quartz.CGPreflightScreenCaptureAccess():
                return {"error": "no screen recording"}
            n = self._window.native
            if not n.isVisible() or n.isMiniaturized():
                return {"error": "hidden"}
            f = n.frame()
            top = AppKit.NSScreen.screens()[0].frame().size.height  # Cocoa counts up from the bottom, CG down from the top
            r = Quartz.CGRectMake(f.origin.x, top - f.origin.y - f.size.height, f.size.width, f.size.height)
            img = Quartz.CGWindowListCreateImage(r, Quartz.kCGWindowListOptionOnScreenBelowWindow, n.windowNumber(),
                                                 Quartz.kCGWindowImageNominalResolution | Quartz.kCGWindowImageBoundsIgnoreFraming)
            if not img:
                return {"error": "no image"}
            ctx = Quartz.CGBitmapContextCreate(None, cols, rows, 8, cols, Quartz.CGColorSpaceCreateDeviceGray(), Quartz.kCGImageAlphaNone)
            Quartz.CGContextSetInterpolationQuality(ctx, Quartz.kCGInterpolationMedium)
            Quartz.CGContextDrawImage(ctx, Quartz.CGRectMake(0, 0, cols, rows), img)
            raw = bytes(Quartz.CGBitmapContextGetData(ctx).as_buffer(cols * rows))
            lin = [round(((v / 255 + 0.055) / 1.055) ** 2.4 if v > 10 else v / 255 / 12.92, 4) for v in range(256)]
            return {"cols": cols, "rows": rows, "y": [lin[v] for v in raw]}
        except Exception as exc:  # noqa: BLE001 - the panes just keep their theme
            return {"error": str(exc)}

    def drag_window(self):
        """Mouse down on the header or the top of the sidebar: the window follows the pointer until the button comes up.
        Tracked in macOS's whole-desktop coordinates, so it crosses displays. pywebview's own drag measured the pointer
        against the screen Tether opened on, so with that screen off to one side the window couldn't leave it."""
        from PyObjCTools import AppHelper
        AppHelper.callAfter(self._drag_start)

    def _drag_start(self) -> None:
        import AppKit
        n = self._window.native if self._window else None
        if getattr(self, "_drag_timer", None):
            self._drag_timer.invalidate()
        if not n or not AppKit.NSEvent.pressedMouseButtons() & 1 or n.styleMask() & AppKit.NSWindowStyleMaskFullScreen:
            return
        p, o = AppKit.NSEvent.mouseLocation(), n.frame().origin
        off = (p.x - o.x, p.y - o.y)

        def follow(timer):
            if not AppKit.NSEvent.pressedMouseButtons() & 1:
                timer.invalidate(); self._drag_timer = None
                return
            q, h = AppKit.NSEvent.mouseLocation(), n.frame().size.height
            x, y = q.x - off[0], q.y - off[1]
            for sc in AppKit.NSScreen.screens():  # like a title bar, the top can't go under the menu bar
                if AppKit.NSPointInRect(q, sc.frame()):
                    v = sc.visibleFrame(); y = min(y, v.origin.y + v.size.height - h)
                    break
            n.setFrameOrigin_((x, y))
        self._drag_timer = AppKit.NSTimer.timerWithTimeInterval_repeats_block_(1 / 120, True, follow)
        AppKit.NSRunLoop.currentRunLoop().addTimer_forMode_(self._drag_timer, AppKit.NSRunLoopCommonModes)

    def zoom(self):
        """Double-click on the header or the top of the sidebar, as on a title bar."""
        from PyObjCTools import AppHelper
        AppHelper.callAfter(lambda: self._window.native.zoom_(None))

    def dropped(self, names):
        """Files dropped on the window: the page sends their names; the full paths are the ones macOS handed over for
        this drop (pywebview's native drop records them in _dnd_state before the page sees the drop)."""
        from webview.dom import _dnd_state
        recorded, _dnd_state["paths"][:] = list(_dnd_state["paths"]), []
        by_name = {urllib.parse.unquote(n): p for n, p in recorded}
        return self._attachments([by_name[n] for n in names if n in by_name])

    # ----- settings -----

    def get_settings(self):
        return {"settings": self.settings, "hotkeys": {k: v[0] for k, v in HOTKEYS.items()}, "mics": voice.input_devices()}

    def save_settings(self, raw):
        for k, v in (raw or {}).items():
            if k in DEFAULTS:
                self.settings[k] = type(DEFAULTS[k])(v) if not isinstance(DEFAULTS[k], list) else list(v)
        self._save()
        from PyObjCTools import AppHelper
        AppHelper.callAfter(self._bind_keys)
        if self.settings["notify"] and not notifier.asked():  # switched on now: macOS asks for permission once
            AppHelper.callAfter(notifier.setup, self._notice_clicked)
        self._dictation.warm(self.settings["whisper_model"])
        return self.settings

    def _save(self) -> None:
        SUPPORT.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(self.settings, indent=1))

    def _bind_keys(self) -> None:
        """Main thread."""
        for key, setting in ((self._voice_key, "voice_key"), (self._circle_key, "circle_key"), (self._markup_key, "markup_key")):
            err = key.set(self.settings[setting])
            if err:
                self._bg(self._emit, {"type": "notice", "level": "error", "text": err})

    def _show_window(self) -> None:
        from PyObjCTools import AppHelper

        def front():
            from AppKit import NSApplication
            NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
            if self._window:
                self._window.show()
        AppHelper.callAfter(front)

    # ---------- mini window ----------
    def set_mini(self, on):
        """Shrink to the mini window or grow back. The page has already started folding its panes; mini.py moves the window."""
        import AppKit
        from PyObjCTools import AppHelper
        n = self._window.native if self._window else None
        if not n or n.styleMask() & AppKit.NSWindowStyleMaskFullScreen:
            return False
        AppHelper.callAfter(self._mini, bool(on))
        return True

    def set_mini_on_top(self, on):
        self.settings["mini_on_top"] = bool(on)
        self._save()
        from PyObjCTools import AppHelper
        AppHelper.callAfter(self._mini_level)
        return self.settings

    def _mini_level(self) -> None:
        import AppKit
        n = self._window.native if self._window else None
        if n:
            n.setLevel_(AppKit.NSFloatingWindowLevel if self._mini_on and self.settings["mini_on_top"] else AppKit.NSNormalWindowLevel)

    def _mini(self, on: bool) -> None:
        """Main thread. Shrinks to the corner (or where you last left it) and grows back to exactly where it was."""
        import AppKit
        n = self._window.native if self._window else None
        if not n or on == self._mini_on or n.styleMask() & AppKit.NSWindowStyleMaskFullScreen:
            return
        self._mini_on = on
        cur = n.frame()
        rect = lambda r: AppKit.NSMakeRect(*r)
        if on:
            self._full_frame = cur
            saved = self.settings.get("mini_frame") or []
            seen = lambda r: any(AppKit.NSIntersectsRect(rect(r), sc.visibleFrame()) for sc in AppKit.NSScreen.screens())
            if len(saved) == 4 and saved[2] >= MINI_MIN[0] and saved[3] >= MINI_MIN[1] and seen(saved):
                to = rect(saved)
            else:
                vis = (n.screen() or AppKit.NSScreen.mainScreen()).visibleFrame()
                w, h = MINI_SIZE[0], min(MINI_SIZE[1], vis.size.height - 32)
                to = AppKit.NSMakeRect(vis.origin.x + vis.size.width - w - 16, vis.origin.y + 16, w, h)
        else:
            self.settings["mini_frame"] = [cur.origin.x, cur.origin.y, cur.size.width, cur.size.height]
            self._save()
            to = self._full_frame or AppKit.NSMakeRect(cur.origin.x, cur.origin.y, 1360, 880)
        self._mini_level()

        mini.run(n, to, lambda: n.setMinSize_(AppKit.NSSize(*(MINI_MIN if self._mini_on else FULL_MIN))))

    # ---------- updates from GitHub ----------
    def claude_status(self, force=False):
        return cc_update.status(engine.find_claude(self.settings.get("claude_path", "")), bool(force))

    def claude_update(self):
        """Open chats keep the Claude Code they started with until they restart; new ones use the new version."""
        b = engine.find_claude(self.settings.get("claude_path", ""))
        return cc_update.update(b) if b else {"ok": False, "why": "Claude Code isn't installed"}

    def update_status(self, force=False):
        return updater.status(bool(force))

    def update_busy(self):
        """Chats a restart would cut off: Claude replying or waiting on you, or a background job still going."""
        return sum(1 for s in list(self._sessions.values())
                   if s.status in ("running", "waiting", "starting") or s.busy_work())

    def update_now(self, chats=None, active=""):
        n = self.update_busy()
        if n:
            return {"busy": n}
        r = updater.apply()
        if r.get("error"):
            return r
        (SUPPORT / "reopen.json").write_text(json.dumps({"chats": chats or [], "active": active or ""}))
        updater.relaunch(r.get("rebuild", False))

        def quit_():
            try:
                self._window.destroy()
            finally:
                threading.Timer(10, os._exit, (0,)).start()  # in case a window hangs on
        threading.Timer(0.4, quit_).start()
        return {"ok": True}

    def restart_now(self, chats=None, active="", force=False):
        """Quit and start again, reopening these chats. Unless forced, only once nothing would be cut off."""
        n = self.update_busy()
        if n and not force:
            return {"busy": n}
        (SUPPORT / "reopen.json").write_text(json.dumps({"chats": chats or [], "active": active or ""}))
        updater.relaunch(False)

        def quit_():
            try:
                self._window.destroy()
            finally:
                threading.Timer(10, os._exit, (0,)).start()  # in case a window hangs on
        threading.Timer(0.4, quit_).start()
        return {"ok": True}

    def code_changed(self):
        """Whether Tether's own files differ from what this running copy loaded (edited on this Mac since it started)."""
        return {"changed": bool(BOOT_CODE) and code_signature() != BOOT_CODE}

    def take_reopen(self):
        """The chats that were open before an update restarted Tether, once."""
        f = SUPPORT / "reopen.json"
        try:
            d = json.loads(f.read_text()); f.unlink()
            return d
        except (OSError, ValueError):
            return {}

    def _shutdown(self) -> None:
        for s in self._sessions.values():
            s.close()
        for sid in list(self._side):
            self.side_close(sid)


def code_signature() -> str:
    """A fingerprint of the files Tether runs: its Python and its page. Backups and caches don't count."""
    import hashlib
    h = hashlib.sha1()
    here = Path(__file__).resolve().parent
    files = sorted([*here.glob("*.py"), *(here / "ui").glob("*.js"), *(here / "ui").glob("*.css"), *(here / "ui").glob("*.html"), here / "markup.html"])
    for f in files:
        try:
            h.update(f.name.encode()); h.update(f.read_bytes())
        except OSError:
            pass
    return h.hexdigest()


try:
    BOOT_CODE = code_signature()
except Exception:  # noqa: BLE001
    BOOT_CODE = ""


def click_through() -> None:
    """One click works on the window even while another app is in front."""
    try:
        import objc
        from webview.platforms.cocoa import BrowserView

        def acceptsFirstMouse_(self, event):
            return True
        objc.classAddMethods(BrowserView.WebKitHost, [
            objc.selector(acceptsFirstMouse_, selector=b"acceptsFirstMouse:", signature=b"Z@:@")])
    except Exception:  # noqa: BLE001
        pass


def dock_reopen(api) -> None:
    """A click on the Dock icon brings Tether's window back. pywebview doesn't answer the Dock, and macOS only restores
    a window itself when none is showing; the markup overlays (invisible, one pixel) always count as showing."""
    try:
        import objc
        from webview.platforms.cocoa import BrowserView

        def reopen(self, app, visible):
            n = api._window.native if api._window else None
            if n is not None:
                if n.isMiniaturized():
                    n.deminiaturize_(None)
                n.makeKeyAndOrderFront_(None)
                app.activateIgnoringOtherApps_(True)
            return False
        objc.classAddMethods(BrowserView.AppDelegate, [
            objc.selector(reopen, selector=b"applicationShouldHandleReopen:hasVisibleWindows:", signature=b"Z@:@Z")])
    except Exception:  # noqa: BLE001
        pass


def right_click() -> None:
    """Right-click shows macOS's Copy, Cut and Paste menu (pywebview empties it)."""
    try:
        from webview.platforms.cocoa import BrowserView
        rightclick.install(BrowserView.WebKitHost)
    except Exception:  # noqa: BLE001
        pass


def _glass_layers(root, radius: float, tint: float) -> None:
    """Inside the window's NSVisualEffectView: blur radius on the backdrop layer, and the material's tint layers
    (its siblings) faded to `tint` of their own opacity, which is kept on the layer the first time it's seen."""
    stack = [root] if root else []
    while stack:
        l = stack.pop()
        subs = list(l.sublayers() or [])
        if any(str(x.className()) == "CABackdropLayer" for x in subs):
            for x in subs:
                if str(x.className()) == "CABackdropLayer":
                    for flt in x.filters() or []:  # AppKit renames it ("gaussianBlur 2") when it rebuilds the material
                        name = str(flt.valueForKey_("name") or "")
                        if name.startswith("gaussianBlur"):
                            x.setValue_forKeyPath_(radius, f"filters.{name}.inputRadius")
                else:
                    base = x.valueForKey_("anvilBase")
                    if base is None:
                        base = x.opacity(); x.setValue_forKey_(base, "anvilBase")
                    x.setOpacity_(float(base) * tint)
            return
        stack.extend(subs)


def glass_window(window) -> None:
    """Float: no title bar, the desktop blurs through (pywebview's NSVisualEffectView behind a clear page), the window
    keeps its shadow, and the traffic lights sit inside the sidebar card. AppKit lays the lights out again on every
    resize, so they're placed again each time."""
    try:
        import AppKit
        n = window.native
        n.setHasShadow_(True)
        for v in n.contentView().subviews():
            if isinstance(v, AppKit.NSVisualEffectView):
                v.setMaterial_(AppKit.NSVisualEffectMaterialHUDWindow)  # lets the most desktop color through, light and dark
        buttons = [n.standardWindowButton_(i) for i in range(3)]
        for b in buttons:
            b.setHidden_(False)

        def place(*_):
            top, left, gap = 17, 20, 20
            bar = buttons[0].superview().superview()
            f = bar.frame()
            f.size.height = buttons[0].frame().size.height + top * 2
            f.origin.y = n.frame().size.height - f.size.height
            bar.setFrame_(f)
            for i, b in enumerate(buttons):
                b.setFrameOrigin_((left + i * gap, top))
            getattr(glass_window, "layers", lambda: None)()  # blur and tint can be reset by AppKit here too
        place()
        centre = AppKit.NSNotificationCenter.defaultCenter()
        for name in ("NSWindowDidResizeNotification", "NSWindowDidExitFullScreenNotification", "NSWindowDidBecomeKeyNotification",
                     "NSWindowDidResignKeyNotification"):
            centre.addObserverForName_object_queue_usingBlock_(name, n, None, place)
        glass_window.keep = place  # the block must outlive this call
    except Exception:  # noqa: BLE001 - a plain window still works
        pass


def on_drop() -> None:
    """Have pywebview's native drop record full file paths, without its DOM drop events: those serialize the whole
    page into JSON for every dragover (1-5 s and 3-60 MB each, many times a second) and hang the window."""
    from webview.dom import _dnd_state
    _dnd_state["num_listeners"] = max(1, _dnd_state["num_listeners"])


def brand_the_process() -> None:
    try:
        from AppKit import NSApplication, NSImage
        from Foundation import NSBundle
        NSBundle.mainBundle().infoDictionary()["CFBundleName"] = APP_NAME
        icon = HERE / "assets" / "icon.png"
        if icon.exists():
            NSApplication.sharedApplication().setApplicationIconImage_(NSImage.alloc().initWithContentsOfFile_(str(icon)))
    except Exception:  # noqa: BLE001
        pass


def keep_page_storage() -> None:
    """Before Tether.app ran Python as its own program, WebKit kept the page's saved layout under "python"."""
    try:
        from Foundation import NSBundle
        bid = NSBundle.mainBundle().bundleIdentifier()
        old, new = Path.home() / "Library/WebKit/python", Path.home() / "Library/WebKit" / str(bid)
        if bid and old.is_dir() and not new.exists():
            import shutil
            shutil.copytree(old, new, symlinks=True)
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    os.environ["TETHER_APP_NAME"] = APP_NAME  # guard.py names the app in its approval reason
    old = next((p for p in OLD_SUPPORTS if p.is_dir()), None)
    if old and not SUPPORT.exists():  # renamed (Claude Workbench → JordCode → Anvil → Tether): keep settings, pins, names
        import shutil
        shutil.copytree(old, SUPPORT)
    SUPPORT.mkdir(parents=True, exist_ok=True)
    if not os.environ.get("ANVIL_RECALL_DIR"):  # recall and screen picked their folder on import, before the copy
        recall.INDEX_DIR = SUPPORT / "recall"; recall.LINEAGE = recall.INDEX_DIR / "lineage.json"
    screen.LAST = SUPPORT / "last-screen.json"; screen.CIRCLED = SUPPORT / "circled.json"
    artifacts.STORE = SUPPORT / "artifacts"
    os.environ["TETHER_LOOK"] = str(SUPPORT / "look.json")  # light or dark now, so Claude's picture of a page matches the panel
    keep_page_storage()
    api = Api()
    webview.settings["DRAG_REGION_DIRECT_TARGET_ONLY"] = True  # the header drags the window; its buttons don't
    webview.settings["DRAG_REGION_SELECTOR"] = ".tether-no-pywebview-drag"  # Api.drag_window moves it instead, across displays
    window = webview.create_window(APP_NAME, url=str(HERE / "ui" / "index.html"), js_api=api, width=1360, height=880,
                                   min_size=(900, 560), background_color="#000000", frameless=True, easy_drag=False,
                                   transparent=True, vibrancy=True)
    api._window = window
    for _ in range(min(4, max(2, len(screen.displays())))):
        api._overlays.append(webview.create_window(
            f"{APP_NAME} markup", url=str(HERE / "markup.html"), js_api=api, width=400, height=300, frameless=True,
            easy_drag=False, focus=False, hidden=True, shadow=False, transparent=True, background_color="#000000",
            on_top=True))
    window.events.closing += api._shutdown
    on_drop()
    window.events.closed += lambda: [o.destroy() for o in api._overlays]
    brand_the_process()
    click_through()
    right_click()
    dock_reopen(api)

    def started():
        from PyObjCTools import AppHelper
        AppHelper.callAfter(api._bind_keys)
        AppHelper.callAfter(glass_window, window)
        if api.settings["notify"]:
            AppHelper.callAfter(notifier.setup, api._notice_clicked)
        api._dictation.warm(api.settings["whisper_model"])
        threading.Thread(target=api._remember_models, daemon=True).start()
        threading.Thread(target=api._watch_files, daemon=True).start()
        threading.Thread(target=api._watch_dock, daemon=True).start()
    webview.start(started)
    return 0


if __name__ == "__main__":
    sys.exit(main())
