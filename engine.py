"""
One Claude Code session = one long-lived `claude -p` process in stream-json mode, run in the session's repo
folder. Sessions are saved by Claude Code as usual (~/.claude/projects), so they can be resumed here, in the
terminal or in VS Code. Your login, CLAUDE.md, skills, MCP servers and permission mode all apply unchanged;
anything Claude Code would ask you about comes back here (`--permission-prompt-tool stdio`) as a card.

The reader thread turns Claude Code's events into small UI events, each tagged with the session id.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

HERE = Path(__file__).resolve().parent
SEARCH_PATHS = ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "~/.local/bin/claude", "~/.claude/local/claude"]
EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
QUIET_TOOLS = {"TodoWrite", "ToolSearch", "SubagentHandback"}
APP_PROMPT = """You are running inside Tether, a desktop window around Claude Code. Work exactly as you
normally do. Extra tools from the workbench MCP server:
- show_artifact: show an HTML page, SVG, Markdown or code file you wrote on the Shelf beside the chat. Use it
  for dashboards, mockups, small tools, diagrams and reports; it returns a picture so you can check how it looks.
- show_table: whenever you have tabular results (a SQL query, a list of records) with more than about 5 rows or 4
  columns, show them with show_table instead of a markdown table, then give a one-line takeaway.
- look_at_screen / list_windows: see the user's screen or a particular window when they refer to something on it.
- mark_up_screen: when your answer is about where something is on screen, draw on it (circles, arrows, numbered
  steps) using pixels from the latest screenshot, including screenshots the user attached or circled.
- recall: look something up in this session's full history (and the session it continues, if any): exact paths,
  IDs, commands, decisions and why, what failed before. Details dropped by compaction are still there. Use it
  before asking the user something they may already have told you, or before redoing work.
- session_notes: the running notes for this session (decisions, facts, open items, gotchas, preferences)."""


def artifact_info(inp: dict, cwd: str) -> dict:
    """show_artifact's file as an absolute path, its title and the note for this version."""
    p = Path(str(inp.get("path") or "")).expanduser()
    p = p if p.is_absolute() else Path(cwd or ".") / p
    return {"path": str(p), "short": short(str(p)), "title": str(inp.get("title") or p.name)[:120], "note": str(inp.get("note") or "")[:120]}


def find_claude(configured: str = "") -> str | None:
    for c in [configured, shutil.which("claude") or "", *SEARCH_PATHS]:
        p = Path(c).expanduser() if c else None
        if p and p.is_file() and os.access(p, os.X_OK):
            return str(p)
    return None


def short(path: str) -> str:
    return str(path).replace(str(Path.home()), "~")


def tool_label(name: str, inp: dict) -> str:
    """One line for a tool call row."""
    if name == "Bash":
        return str(inp.get("description") or inp.get("command") or "")[:140]
    if name in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit"):
        verb = {"Read": "Read", "Write": "Write", "NotebookEdit": "Edit"}.get(name, "Edit")
        return f"{verb} {short(str(inp.get('file_path') or inp.get('notebook_path') or ''))}"
    if name in ("Glob", "Grep"):
        return f"Search “{inp.get('pattern', '')}”" + (f" in {short(inp['path'])}" if inp.get("path") else "")
    if name == "WebSearch":
        return f"Web search “{inp.get('query', '')}”"
    if name == "WebFetch":
        return f"Fetch {inp.get('url', '')}"[:140]
    if name in ("Task", "Agent"):
        return f"Agent: {inp.get('description', 'sub-task')}"
    if name == "Skill":
        return f"Skill: {inp.get('skill', '')}"
    if name.startswith("mcp__"):
        _, server, tool = (name.split("__", 2) + ["", ""])[:3]
        return f"{server} · {tool.replace('_', ' ')}"
    return name


AGENT_TOOLS = ("Task", "Agent")


def agent_info(name: str, inp: dict) -> dict:
    """Extra fields for a sub-agent call, so the page can give it its own lane."""
    if name not in AGENT_TOOLS:
        return {}
    return {"agent": {"type": inp.get("subagent_type") or "general-purpose", "description": inp.get("description") or "Sub-task",
                      "prompt": str(inp.get("prompt") or "")[:6000], "background": bool(inp.get("run_in_background"))}}


def agent_stats(name: str, res) -> dict:
    """What a finished sub-agent reports about itself (tool calls, time, tokens)."""
    if name not in AGENT_TOOLS or not isinstance(res, dict):
        return {}
    return {"agent_stats": {"tools": res.get("totalToolUseCount"), "ms": res.get("totalDurationMs"), "tokens": res.get("totalTokens")}}


def result_text(block: dict) -> str:
    c = block.get("content")
    if isinstance(c, list):
        return "\n".join(str(x.get("text", "")) if x.get("type") == "text" else "[image]" for x in c if isinstance(x, dict))
    return str(c or "")


def _read(path: str) -> str | None:
    try:
        p = Path(path).expanduser()
        if p.is_file() and p.stat().st_size < 2_000_000:
            return p.read_text(errors="replace")
    except OSError:
        pass
    return None


def make_diff(before: str | None, after: str | None) -> dict:
    """Line diff for the chat: rows of [kind, old line no, new line no, text], with 3 lines of context."""
    a, b = (before or "").splitlines(), (after or "").splitlines()
    rows: list = []
    added = removed = 0
    for group in difflib.SequenceMatcher(None, a, b, autojunk=False).get_grouped_opcodes(3):
        if rows:
            rows.append(["gap", None, None, ""])
        for tag, i1, i2, j1, j2 in group:
            if tag == "equal":
                rows += [["ctx", i1 + k + 1, j1 + k + 1, a[i1 + k]] for k in range(i2 - i1)]
                continue
            if tag in ("replace", "delete"):
                rows += [["del", i1 + k + 1, None, a[i1 + k]] for k in range(i2 - i1)]
                removed += i2 - i1
            if tag in ("replace", "insert"):
                rows += [["add", None, j1 + k + 1, b[j1 + k]] for k in range(j2 - j1)]
                added += j2 - j1
    return {"rows": rows[:1500], "added": added, "removed": removed, "new": before is None, "truncated": len(rows) > 1500}


class Session:
    def __init__(self, emit: Callable[[dict], None], cwd: str, settings: dict, sid: str | None = None,
                 resume: bool = False, title: str = ""):
        self.emit = emit
        self.cwd = cwd
        self.settings = settings
        self.sid = sid or str(uuid.uuid4())
        self.resume = resume  # an existing Claude Code session: start the process with --resume
        self.title = title
        self.model = settings.get("model", "")
        self.effort = settings.get("effort", "")
        self.perm_mode = settings.get("perm_mode", "")   # "" = your Claude Code default
        self.fast = bool(settings.get("fast", False))
        self.modes = {"permission": "", "fast": "", "fast_reason": ""}  # what Claude Code reports back
        self.status = "idle" if resume else "new"  # new | starting | idle | running | waiting | exited
        self.proc: subprocess.Popen | None = None
        self.allowed: set[str] = set()  # "always allow in this session"
        self.pending: dict[str, dict] = {}  # permission request id -> request
        self.models: list = []
        self.commands: list = []
        # what loaded in this session (Stats): connectors from mcp_status, skills/plugins/agents from startup
        self.loaded: dict = {"mcp": None, "user_skills": [], "skills": None, "plugins": None, "agents": []}
        self._mcp_asks = 0
        self.context_tokens = 0
        self.ctx_usage: dict = {}
        self.api_model = ""
        self._tasks: dict[str, str] = {}  # sub-agent task id -> the Agent tool call's id
        self._bg_agents: set[str] = set()  # background sub-agents still running (they die with the process too)
        # background jobs (shell commands, monitors): task id -> what the page shows. They live inside this
        # Claude process, so closing or restarting it stops them; callers check running_jobs() first.
        self.jobs: dict[str, dict] = {}
        self._fg: dict[str, dict] = {}  # foreground commands Claude Code reports as tasks; a job only if moved to the background
        self._restart_pending = False
        self._lock = threading.Lock()
        self._tools: dict[str, tuple[str, dict]] = {}
        self._before: dict[str, str | None] = {}
        self._stderr: list[str] = []
        self.last_own = 0.0  # when our own process last wrote anything (it saves the session file as it goes)

    # ----- process -----

    def _start(self) -> None:
        binary = find_claude(self.settings.get("claude_path", ""))
        if not binary:
            raise RuntimeError("Couldn't find the claude command. Install Claude Code or set its path in Settings.")
        mcp = {"mcpServers": {"workbench": {"command": sys.executable, "args": [str(HERE / "wb_mcp.py")],
                                            "env": {"FORGE_APP_PID": str(os.getpid()), "ANVIL_SID": self.sid,
                                                    **({"ANVIL_RECALL_DIR": os.environ["ANVIL_RECALL_DIR"]} if os.environ.get("ANVIL_RECALL_DIR") else {}),
                                                    **({"TETHER_LOOK": os.environ["TETHER_LOOK"]} if os.environ.get("TETHER_LOOK") else {})}}}}
        cmd = [binary, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--include-partial-messages", "--replay-user-messages", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
               "--mcp-config", json.dumps(mcp), "--settings", json.dumps({**({"fastMode": True} if self.fast and not self.settings.get("fast_unavailable") else {})}),
               "--append-system-prompt", APP_PROMPT]
        # Claude Code saves a session only once it gets a message; one that restarted before that (a model switch,
        # a context check) isn't on disk yet, and --resume would fail with "No conversation found"
        saved = self.resume and any((Path.home() / ".claude" / "projects").glob(f"*/{self.sid}.jsonl"))
        cmd += ["--resume", self.sid] if saved else ["--session-id", self.sid]
        if self.perm_mode:
            cmd += ["--permission-mode", self.perm_mode]
        if self.model:
            cmd += ["--model", self.model]
        if self.effort:
            cmd += ["--effort", self.effort]
        if self.settings.get("show_thinking", True):
            cmd += ["--thinking-display", "summarized"]
        env = {k: v for k, v in os.environ.items()
               if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "CLAUDE_AGENT_SDK_VERSION")}
        env["PATH"] = os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"),
                                       "/usr/bin", "/bin", "/usr/sbin", "/sbin", env.get("PATH", "")])
        self._set("starting")
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True, bufsize=1, cwd=self.cwd, env=env)
        self.resume = True  # from now on it exists on disk
        threading.Thread(target=self._read_out, args=(self.proc,), daemon=True).start()
        threading.Thread(target=self._read_err, args=(self.proc,), daemon=True).start()
        self._send({"type": "control_request", "request_id": "init", "request": {"subtype": "initialize", "hooks": None}})

    @property
    def alive(self) -> bool:
        return bool(self.proc) and self.proc.poll() is None

    def _send(self, obj: dict) -> None:
        with self._lock:
            if self.proc and self.proc.stdin:
                self.proc.stdin.write(json.dumps(obj) + "\n")
                self.proc.stdin.flush()

    def _set(self, status: str) -> None:
        self.status = status
        self.emit({"type": "session_state", "sid": self.sid, "status": status, "title": self.title,
                   "model": self.model, "effort": self.effort, "context": self.context_tokens})

    def running_jobs(self) -> list[dict]:
        return [j for j in self.jobs.values() if j["status"] == "running"]

    def busy_work(self) -> bool:
        """Background commands or background sub-agents still running: closing the process would stop them."""
        return bool(self.running_jobs() or self._bg_agents)

    def close(self) -> None:
        for j in self.running_jobs():  # they die with the process
            self._job_end(j["task_id"], "stopped", "Stopped when Tether closed Claude for this chat")
        p, self.proc = self.proc, None
        if p:
            try:
                p.stdin.close()
                p.terminate()
            except (OSError, ValueError):
                pass

    def restart(self, model: str | None = None, effort: str | None = None) -> None:
        """New model or effort: Claude Code takes those at start, so reopen the same session with them."""
        if model is not None:
            self.model = model
        if effort is not None:
            self.effort = effort
        if self.alive and self.running_jobs():
            self._restart_pending = True
            self.emit({"type": "notice", "sid": self.sid, "text": "The switch waits until the background job ends, so it isn't stopped."})
            self._set(self.status)
        elif self.alive:
            self.close()
            self._start()
            self._set("idle")
        else:
            self._set(self.status if self.status != "exited" else "idle")

    # ----- talking to it -----

    def send(self, text: str, images: list[dict] | None = None) -> None:
        if self._restart_pending and not self.running_jobs():  # a model or effort switch that waited for a job
            self._restart_pending = False
            self.close()
        if not self.alive:
            self._start()
        content: list | str = text
        if images:
            content = [{"type": "image", "source": {"type": "base64", "media_type": im.get("media_type", "image/png"),
                                                     "data": im["data"]}} for im in images]
            content.append({"type": "text", "text": text or "(see the attached image)"})
        if not self.title:
            self.title = (text or "Image").strip().splitlines()[0][:70]
        self._send({"type": "user", "message": {"role": "user", "content": content}})
        self._set("running")

    FAST_REASONS = {"preference": "Fast mode has been disabled by your organization",
                    "free": "Fast mode needs a paid plan or usage credits", "extra_usage_disabled": "Fast mode needs extra usage turned on",
                    "network_error": "Fast mode is unavailable: network problem", "unknown": "Fast mode is unavailable right now"}

    def _modes(self, permission, fast, reason) -> None:
        if permission:
            self.modes["permission"] = permission
        if fast:
            self.modes["fast"] = fast
        if reason is not None or fast == "on":
            self.modes["fast_reason"] = self.FAST_REASONS.get(reason or "", reason or "") if fast != "on" else ""
        if self.fast and fast == "off" and reason and reason != "sdk_opt_in_required":  # asked for it and the account said no
            self.emit({"type": "fast_unavailable", "sid": self.sid, "reason": self.modes["fast_reason"]})
        self.emit({"type": "modes", "sid": self.sid, **self.modes, "want_fast": self.fast})

    def set_permission_mode(self, mode: str) -> None:
        """Switch live; Claude Code applies it from the next tool call."""
        self.perm_mode = mode
        if self.alive:
            self._send({"type": "control_request", "request_id": f"pm_{uuid.uuid4().hex[:8]}",
                        "request": {"subtype": "set_permission_mode", "mode": mode or "auto"}})
        self._modes(mode or None, None, None)

    def set_fast(self, on: bool) -> None:
        self.fast = bool(on)
        if self.alive:
            self._send({"type": "control_request", "request_id": f"fm_{uuid.uuid4().hex[:8]}",
                        "request": {"subtype": "apply_flag_settings", "settings": {"fastMode": self.fast}}})
        self.emit({"type": "modes", "sid": self.sid, **self.modes, "want_fast": self.fast})

    def _task(self, e: dict) -> None:
        """Sub-agents (foreground and background) report through task_* system events, keyed by the Agent call's id."""
        sub, tid = e.get("subtype"), e.get("task_id")
        if tid in self._fg:  # a foreground command: shown as its tool row only, unless it's moved to the background
            patch = e.get("patch") or {}
            if e.get("is_backgrounded") or patch.get("is_backgrounded"):
                self._job_start({**self._fg.pop(tid), **({"description": e["description"]} if e.get("description") else {})})
            elif sub == "task_notification" or (patch.get("status") or e.get("status")) not in (None, "running", "pending"):
                self._fg.pop(tid, None)
            return
        if tid in self.jobs:
            st = e.get("status") or (e.get("patch") or {}).get("status")
            if sub in ("task_notification", "task_updated") and st and st not in ("running", "pending"):
                self._job_end(tid, st, str(e.get("summary") or ""), e.get("output_file"))
            return
        if sub == "task_started":
            if e.get("task_type") not in (None, "local_agent") and not e.get("subagent_type"):
                if e.get("is_backgrounded") is False:
                    self._fg[tid] = e
                else:
                    self._job_start(e)  # a background shell command, monitor and the like
                return
            self._tasks[tid] = e.get("tool_use_id")
            if e.get("is_backgrounded"):
                self._bg_agents.add(tid)
            self.emit({"type": "agent", "sid": self.sid, "id": e.get("tool_use_id"), "agent_id": tid,
                       "agent_type": e.get("subagent_type") or "", "description": e.get("description") or "",
                       "prompt": str(e.get("prompt") or "")[:6000], "background": bool(e.get("is_backgrounded"))})
            return
        use = e.get("tool_use_id") or self._tasks.get(tid)
        if tid not in self._tasks or not use:
            return
        if sub == "task_progress":
            u = e.get("usage") or {}
            self.emit({"type": "agent_step", "sid": self.sid, "id": use, "text": e.get("description") or "",
                       "tool": e.get("last_tool_name") or "", "tokens": u.get("total_tokens"), "tools": u.get("tool_uses"), "ms": u.get("duration_ms")})
        elif sub == "task_notification" or (sub == "task_updated" and (e.get("patch") or {}).get("status") in ("failed", "killed", "stopped")):
            status = e.get("status") or (e.get("patch") or {}).get("status")
            self._bg_agents.discard(tid)
            u = e.get("usage") or {}
            self.emit({"type": "agent_done", "sid": self.sid, "id": use, "status": status, "summary": str(e.get("summary") or "")[:8000],
                       "tokens": u.get("total_tokens"), "tools": u.get("tool_uses"), "ms": u.get("duration_ms")})

    def _job_start(self, e: dict) -> None:
        tid = e.get("task_id")
        if not tid:
            return
        self.jobs[tid] = j = {"task_id": tid, "id": e.get("tool_use_id") or "", "description": e.get("description") or "Background job",
                              "kind": e.get("task_type") or "", "status": "running", "started": time.time(), "ended": None,
                              "summary": "", "exit": None, "output_file": ""}
        self.emit({"type": "job", "sid": self.sid, **j})

    def _job_end(self, tid: str, status: str, summary: str = "", output_file: str | None = None) -> None:
        j = self.jobs.get(tid)
        if not j or (j["status"] != "running" and not summary):
            return
        if j["status"] == "running":
            j["status"], j["ended"] = status, time.time()
        j["summary"] = summary or j["summary"]
        m = re.search(r"exit code (-?\d+)", summary or "")
        if m:
            j["exit"] = int(m.group(1))
        j["output_file"] = output_file or j["output_file"]
        self.emit({"type": "job_done", "sid": self.sid, **j})

    def request_context(self, start: bool = False) -> None:
        """Ask Claude Code how full the context is (the same numbers as /context); the answer arrives as an event.
        start=True opens the process first (no tokens spent) for a past session that hasn't been messaged yet."""
        if start and not self.alive:
            self._start()  # sends initialize; its answer asks for the context
            return
        if self.alive:
            self._send({"type": "control_request", "request_id": f"ctx_{uuid.uuid4().hex[:8]}", "request": {"subtype": "get_context_usage"}})

    def request_loaded(self, start: bool = False) -> None:
        """Ask Claude Code which connectors are up (no tokens); the answer arrives as a "loaded" event.
        start=True opens the process first for a past session that hasn't been messaged yet."""
        if start and not self.alive:
            self._start()  # its initialize answer asks for this
            return
        if self.alive:
            self._send({"type": "control_request", "request_id": f"mcp_{uuid.uuid4().hex[:8]}", "request": {"subtype": "mcp_status"}})

    def compact(self, focus: str = "") -> None:
        self.send(("/compact " + focus.strip()).strip())

    def interrupt(self) -> None:
        for rid in list(self.pending):
            self.answer(rid, "deny")
        if self.alive and self.status in ("running", "waiting"):
            self._send({"type": "control_request", "request_id": f"int_{uuid.uuid4().hex[:8]}",
                        "request": {"subtype": "interrupt"}})

    def answer(self, rid: str, choice: str, answers: dict | None = None, note: str = "") -> None:
        """A permission card was answered: allow | always | deny (or a question's answers)."""
        req = self.pending.pop(rid, None)
        if not req:
            return
        inp = req.get("input") or {}
        if answers is not None:
            resp = {"behavior": "allow", "updatedInput": {**inp, "answers": answers}}
        elif choice in ("allow", "always"):
            if choice == "always" and not req.get("guarded"):
                self.allowed.add(self._allow_key(req.get("tool_name", ""), inp))
            resp = {"behavior": "allow", "updatedInput": inp}
        else:
            resp = {"behavior": "deny", "message": note or "The user declined this. Don't do it; carry on without it, or ask them."}
        self._send({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": resp}})
        self.emit({"type": "permission_done", "sid": self.sid, "rid": rid, "choice": "answered" if answers else choice})
        if not self.pending and self.status == "waiting":
            self._set("running")

    @staticmethod
    def _allow_key(name: str, inp: dict) -> str:
        if name == "Bash":  # the command's first word, e.g. every `databricks ...` call
            words = str(inp.get("command") or "").split()
            return f"Bash:{words[0] if words else ''}"
        return name

    # ----- reading its events -----

    def _read_err(self, proc) -> None:
        for line in proc.stderr:
            self._stderr = (self._stderr + [line.rstrip()])[-30:]

    def _read_out(self, proc) -> None:
        for line in proc.stdout:
            self.last_own = time.time()
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                self._event(json.loads(line))
            except Exception as exc:  # noqa: BLE001 - one bad event mustn't kill the session
                self.emit({"type": "notice", "level": "error", "text": f"Couldn't show an event: {exc}"})
        if proc is self.proc or self.proc is None:
            tail = " ".join(l for l in self._stderr[-4:] if l)[:400]
            self._set("exited")
            if tail and proc.returncode not in (0, -15, None):
                self.emit({"type": "error", "sid": self.sid, "text": f"Claude Code stopped: {tail}"})

    def _event(self, e: dict) -> None:
        kind = e.get("type")
        sid = self.sid
        parent = e.get("parent_tool_use_id")
        if kind == "control_response":
            r = e.get("response", {})
            if str(r.get("request_id", "")).startswith("mcp_"):
                servers = (r.get("response") or {}).get("mcpServers") or []
                self.loaded["mcp"] = [{"name": m.get("name", ""), "status": m.get("status", ""), "tools": len(m.get("tools") or []),
                                       "error": str(m.get("error") or "")[:200]} for m in servers]
                self.emit({"type": "loaded", "sid": sid})
                if any(m["status"] == "pending" for m in self.loaded["mcp"]) and self._mcp_asks < 8:  # still connecting: ask again shortly
                    self._mcp_asks += 1
                    threading.Timer(1.5, self.request_loaded).start()
                return
            if str(r.get("request_id", "")).startswith("ctx_"):
                body = r.get("response") or {}
                if body.get("maxTokens"):
                    self.ctx_usage = {k: body.get(k) for k in ("totalTokens", "maxTokens", "percentage", "categories", "autocompactSource")}
                    self.ctx_usage["model"] = self.api_model
                    self.context_tokens = body.get("totalTokens") or self.context_tokens
                    self.emit({"type": "context", "sid": sid, **self.ctx_usage})
                return
            if r.get("request_id") == "init":
                body = r.get("response") or {}
                self.models = body.get("models") or []
                self.commands = [c.get("name") for c in body.get("commands") or [] if c.get("name")]
                self.loaded["user_skills"] = [c["name"] for c in body.get("commands") or []
                                              if c.get("name") and str(c.get("description", "")).endswith(("(user)", "(project)"))]
                self.loaded["agents"] = [a.get("name") for a in body.get("agents") or [] if a.get("name")]
                if self.loaded["plugins"] is None:  # until the first message brings the full list: plugins that have skills
                    self.loaded["plugins"] = sorted({n.split(":")[0] for n in self.commands if ":" in n})
                self._mcp_asks = 0
                self.request_loaded()
                self.emit({"type": "session_info", "sid": sid, "models": self.models, "commands": self.commands})
                if self.status == "starting":
                    self._set("idle")
                self.request_context()  # true numbers for this model straight away (also after a model switch)
            return
        if kind == "system":
            if e.get("subtype") == "init":
                self.api_model = e.get("model") or self.api_model
                self.loaded["skills"] = list(e.get("skills") or [])
                self.loaded["plugins"] = [x.get("name") for x in e.get("plugins") or [] if x.get("name") and x.get("path") != "builtin"]
                self.emit({"type": "loaded", "sid": sid})
                self._modes(e.get("permissionMode"), e.get("fast_mode_state"), None)
            if e.get("subtype") == "init" and not self.commands:
                self.commands = e.get("slash_commands") or []
                self.emit({"type": "session_info", "sid": sid, "commands": self.commands, "models": self.models})
            elif e.get("subtype") == "compact_boundary":
                m = e.get("compact_metadata") or {}
                pre, post = m.get("pre_tokens"), m.get("post_tokens")
                self.emit({"type": "compaction", "sid": sid, "trigger": m.get("trigger", ""), "pre": pre, "post": post, "summary": None})
                self.emit({"type": "compacted", "sid": sid})
            elif str(e.get("subtype", "")).startswith("task_"):
                self._task(e)
            elif e.get("subtype") == "status":
                if e.get("status") == "requesting":  # a request to the model just went out; its thinking arrives only when it's done
                    self.emit({"type": "requesting", "sid": sid})
                self.emit({"type": "compacting", "sid": sid, "on": e.get("status") == "compacting"})
            return
        if parent:  # a sub-agent's own messages: its lane follows the task_* events instead
            return
        if kind == "stream_event":
            ev = e.get("event", {})
            t = ev.get("type")
            if t == "content_block_start":
                bt = (ev.get("content_block") or {}).get("type")
                if bt in ("text", "thinking"):
                    self.emit({"type": f"{bt}_start", "sid": sid})
            elif t == "content_block_delta":
                d = ev.get("delta", {})
                if d.get("type") == "text_delta":
                    self.emit({"type": "text_delta", "sid": sid, "text": d.get("text", "")})
                elif d.get("type") == "thinking_delta" and d.get("thinking"):
                    self.emit({"type": "thinking_delta", "sid": sid, "text": d["thinking"]})
            elif t == "message_start":
                u = (ev.get("message") or {}).get("usage") or {}
                total = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
                if total:
                    self.context_tokens = total
                    self.emit({"type": "usage", "sid": sid, "context": total})
            return
        if kind == "assistant":
            for b in e.get("message", {}).get("content", []):
                if b.get("type") != "tool_use":
                    continue
                name, inp, tid = b.get("name", ""), b.get("input") or {}, b.get("id")
                self._tools[tid] = (name, inp)
                if name in EDIT_TOOLS:
                    self._before[tid] = _read(str(inp.get("file_path") or inp.get("notebook_path") or ""))
                if name == "mcp__workbench__show_table":
                    self.emit({"type": "table", "sid": sid, "id": tid, "title": inp.get("title", ""),
                               "columns": inp.get("columns") or [], "rows": inp.get("rows") or [], "note": inp.get("note", "")})
                    continue
                if name == "mcp__workbench__show_artifact":
                    self.emit({"type": "artifact", "sid": sid, "id": tid, **artifact_info(inp, self.cwd)})
                    continue
                if name == "mcp__workbench__mark_up_screen":
                    self.emit({"type": "markup", "sid": sid, "marks": inp.get("marks") or []})
                if name in QUIET_TOOLS:
                    continue
                self.emit({"type": "tool", "sid": sid, "id": tid, "name": name, "label": tool_label(name, inp),
                           "input": json.dumps(inp, indent=1, ensure_ascii=False)[:6000],
                           "command": inp.get("command") if name == "Bash" else None, **agent_info(name, inp)})
            return
        if kind == "user" and e.get("isReplay"):  # Claude just took in one of your messages (a queued one: mid-turn)
            if not e.get("parent_tool_use_id"):
                c = e.get("message", {}).get("content")
                text = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
                self.emit({"type": "delivered", "sid": sid, "text": text})
            return
        if kind == "user":
            content = e.get("message", {}).get("content")
            for b in content if isinstance(content, list) else []:
                if b.get("type") != "tool_result":
                    continue
                tid = b.get("tool_use_id")
                name, inp = self._tools.pop(tid, ("", {}))
                ok = not b.get("is_error")
                if name in EDIT_TOOLS and tid in self._before:
                    path = str(inp.get("file_path") or inp.get("notebook_path") or "")
                    before = self._before.pop(tid)
                    if ok:
                        self.emit({"type": "diff", "sid": sid, "id": tid, "file": path, "short": short(path),
                                   **make_diff(before, _read(path))})
                if name in QUIET_TOOLS or name == "mcp__workbench__show_table":
                    continue
                if name == "mcp__workbench__show_artifact":
                    self.emit({"type": "artifact_checked", "sid": sid, "id": tid, "ok": ok, "text": result_text(b)[:600]})
                    continue
                m = re.search(r"\A[^\n]{0,120}?with ID: (\w+)\. Output is being written to: (\S+?)\.?(?:\s|$)", result_text(b).lstrip())
                if m and m.group(1) in self.jobs:
                    self.jobs[m.group(1)]["output_file"] = m.group(2)
                self.emit({"type": "tool_result", "sid": sid, "id": tid, "ok": ok, "output": result_text(b)[:8000],
                           **agent_stats(name, e.get("tool_use_result") or e.get("toolUseResult"))})
            return
        if kind == "control_request":
            self._permission(e)
            return
        if kind == "result":
            self.request_context()
            self._modes(None, e.get("fast_mode_state"), e.get("fast_mode_disabled_reason"))
            if e.get("total_cost_usd") is not None:
                self.live_cost = {"usd": e.get("total_cost_usd"), "models": e.get("modelUsage") or {}}
            for rid in list(self.pending):  # nothing left to ask about
                self.pending.pop(rid, None)
                self.emit({"type": "permission_done", "sid": sid, "rid": rid, "choice": "gone"})
            self.emit({"type": "result", "sid": sid, "ok": not e.get("is_error"), "subtype": e.get("subtype"),
                       "error": str(e.get("result") or "; ".join(map(str, e.get("errors") or [])))[:400] if e.get("is_error") else "",
                       "cost": e.get("total_cost_usd"), "seconds": round((e.get("duration_ms") or 0) / 1000, 1)})
            self._set("idle")

    def _permission(self, e: dict) -> None:
        req, rid = e.get("request", {}), e.get("request_id")
        if req.get("subtype") != "can_use_tool":
            self._send({"type": "control_response", "response": {"subtype": "success", "request_id": rid, "response": {}}})
            return
        name, inp = req.get("tool_name", ""), req.get("input") or {}
        guarded = str(req.get("decision_reason") or "").startswith(("Tether", "Anvil", "JordCode", "Workbench"))
        req["guarded"] = guarded
        self.pending[rid] = req
        if not guarded and name not in ("AskUserQuestion", "ExitPlanMode") and self._allow_key(name, inp) in self.allowed:
            self.answer(rid, "allow")
            return
        card = {"type": "permission", "sid": self.sid, "rid": rid, "tool": name, "guarded": guarded,
                "label": tool_label(name, inp), "reason": str(req.get("decision_reason") or ""),
                "detail": str(inp.get("command") or "") if name == "Bash" else json.dumps(inp, indent=1, ensure_ascii=False)[:4000]}
        if name == "AskUserQuestion":
            card.update(kind="question", questions=inp.get("questions") or [])
        elif name == "ExitPlanMode":
            card.update(kind="plan", plan=str(inp.get("plan") or ""))
        elif name in EDIT_TOOLS:
            path = str(inp.get("file_path") or "")
            after = inp.get("content") if name == "Write" else None
            before = _read(path)
            if name == "Edit" and before is not None:
                after = before.replace(str(inp.get("old_string", "")), str(inp.get("new_string", "")),
                                       -1 if inp.get("replace_all") else 1)
            if after is not None:
                card["diff"] = {"short": short(path), **make_diff(before, after)}
        self._set("waiting")
        self.emit(card)
