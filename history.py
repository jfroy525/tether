"""
Past Claude Code sessions, from ~/.claude/projects (the same ones VS Code and the terminal can resume): a fast
list for the sidebar (head and tail of each file only), and a full transcript when one is opened.
"""

from __future__ import annotations

import json
import re
import os
import time
from datetime import datetime
from pathlib import Path

import engine

PROJECTS = Path.home() / ".claude" / "projects"
SKIP_PREFIXES = ("<command-", "<local-command", "<system-reminder", "Caveat:", "<task-notification>")


def _head_tail(path: Path, n: int = 48_000) -> tuple[list[str], list[str]]:
    size = path.stat().st_size
    with path.open("rb") as f:
        head = f.read(n).decode(errors="replace").splitlines()
        if size <= n:
            return head, head
        f.seek(max(0, size - n))
        tail = f.read().decode(errors="replace").splitlines()[1:]  # first line is probably cut
    return head[:-1], tail


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _summary(path: Path) -> dict | None:
    try:
        head, tail = _head_tail(path)
    except OSError:
        return None
    info = {"id": path.stem, "cwd": "", "branch": "", "title": "", "first": "", "mtime": path.stat().st_mtime}
    for line in head:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if not info["cwd"] and e.get("cwd"):
            info["cwd"], info["branch"] = e["cwd"], e.get("gitBranch", "")
        if not info["first"] and e.get("type") == "user" and not e.get("isMeta") and not e.get("isSidechain"):
            t = _text_of((e.get("message") or {}).get("content")).strip()
            if t and not t.startswith(SKIP_PREFIXES):
                info["first"] = t.splitlines()[0][:90]
        if info["cwd"] and info["first"]:
            break
    if not (info["cwd"] and info["first"]):  # a fresh start opens with a long handoff, past the head
        with path.open(errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 2000 or (info["cwd"] and info["first"]):
                    break
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if not info["cwd"] and e.get("cwd"):
                    info["cwd"], info["branch"] = e["cwd"], e.get("gitBranch", "")
                if not info["first"] and e.get("type") == "user" and not e.get("isMeta") and not e.get("isSidechain"):
                    t = _text_of((e.get("message") or {}).get("content")).strip()
                    if t and not t.startswith(SKIP_PREFIXES):
                        info["first"] = t.splitlines()[0][:90]
    for line in reversed(tail):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("type") == "custom-title" and e.get("customTitle"):
            info["title"] = e["customTitle"]
            break
        if e.get("type") == "ai-title" and e.get("aiTitle") and not info["title"]:
            info["title"] = e["aiTitle"]
        if e.get("gitBranch") and not info.get("last_branch"):
            info["last_branch"] = e["gitBranch"]
    info["branch"] = info.pop("last_branch", "") or info["branch"]
    info["title"] = info["title"] or info["first"]
    if not info["cwd"] or not info["title"]:
        return None
    return info


def list_sessions(days: int = 45, limit: int = 300) -> list[dict]:
    """Recent sessions, newest first."""
    cutoff = time.time() - days * 86400
    files = []
    for d in PROJECTS.iterdir() if PROJECTS.exists() else []:
        if not d.is_dir():
            continue
        for f in d.glob("*.jsonl"):
            try:
                m = f.stat().st_mtime
            except OSError:
                continue
            if m >= cutoff:
                files.append((m, f))
    out = []
    for _, f in sorted(files, reverse=True)[:limit]:
        s = _summary(f)
        if s and Path(s["cwd"]).exists():
            out.append(s)
    return out


def find_file(sid: str) -> Path | None:
    for d in PROJECTS.iterdir() if PROJECTS.exists() else []:
        f = d / f"{sid}.jsonl"
        if f.exists():
            return f
    return None


def transcript(sid: str, max_items: int = 600, marks: list[dict] | None = None) -> list[dict]:
    """A saved session as UI events (the same shapes the live engine emits), most recent max_items.
    marks: Tether's own lines ({"ts": ISO time, "text"}, e.g. a model switch), placed where they happened."""
    f = find_file(sid)
    if not f:
        return []
    items: list[dict] = []
    marks = sorted(marks or [], key=lambda m: m.get("ts", ""))
    tools: dict[str, int] = {}
    boundary: dict = {}
    with f.open(errors="replace") as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            while marks and e.get("timestamp") and e["timestamp"] > marks[0].get("ts", ""):
                items.append({"type": "switch", "text": marks.pop(0).get("text", "")})
            if e.get("subtype") == "compact_boundary" and not e.get("isSidechain"):
                boundary = e.get("compactMetadata") or {}
                continue
            if "<task-notification>" in line and not e.get("isSidechain"):  # a background agent finished
                _agent_done(items, tools, e.get("content") if isinstance(e.get("content"), str) else _text_of((e.get("message") or {}).get("content")),
                            e.get("timestamp"))
            att = e.get("attachment") if e.get("type") == "attachment" and not e.get("isSidechain") else None
            if att and att.get("type") == "queued_command":  # a message you sent while Claude worked, where Claude read it
                prompt = att.get("prompt")
                text = _text_of(prompt).strip() if isinstance(prompt, list) else str(prompt or "").strip()
                images = sum(1 for b in prompt if isinstance(b, dict) and b.get("type") == "image") if isinstance(prompt, list) else 0
                if (text and not text.startswith(SKIP_PREFIXES)) or images:
                    items.append({"type": "user", "text": text, "images": images})
                continue
            if e.get("isSidechain") or e.get("type") not in ("user", "assistant"):
                continue
            content = (e.get("message") or {}).get("content")
            if e["type"] == "user":
                if e.get("isCompactSummary"):
                    items.append(compaction_item(boundary, _text_of(content)))
                    boundary = {}
                    continue
                if e.get("isMeta"):
                    continue
                if isinstance(content, list) and any(b.get("type") == "tool_result" for b in content if isinstance(b, dict)):
                    for b in content:
                        if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("tool_use_id") in tools:
                            items[tools[b["tool_use_id"]]]["ok"] = not b.get("is_error")
                            items[tools[b["tool_use_id"]]]["output"] = engine.result_text(b)[:3000]
                            it = items[tools[b["tool_use_id"]]]
                            r = e.get("toolUseResult")
                            bg = BG_RE.search(it["output"].lstrip())
                            if bg and not it.get("agent"):  # a background job: its end arrives later as a task notification
                                it["job"] = {"task_id": bg.group(1), "output_file": bg.group(2), "status": "unknown",
                                             "description": it["label"], "started": _ts(e.get("timestamp")), "ended": None, "summary": "", "exit": None}
                            if it.get("agent") and isinstance(r, dict):
                                it["agent_id"] = r.get("agentId")
                                it["agent_type"] = r.get("agentType") or it["agent"].get("type")
                                it["status"] = "running" if r.get("status") == "async_launched" else r.get("status") or ("failed" if b.get("is_error") else "completed")
                                it.update(tokens=r.get("totalTokens"), tools=r.get("totalToolUseCount"), ms=r.get("totalDurationMs"))
                    continue
                text = _text_of(content).strip()
                images = sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image") if isinstance(content, list) else 0
                if text.startswith("<command-name>"):
                    name = text.split("<command-name>")[1].split("</command-name>")[0]
                    items.append({"type": "user", "text": name})
                elif text and not text.startswith(SKIP_PREFIXES) or images:
                    items.append({"type": "user", "text": text, "images": images})
                continue
            for b in content if isinstance(content, list) else []:
                t = b.get("type")
                if t == "text" and b.get("text", "").strip():
                    if items and items[-1]["type"] == "text":
                        items[-1]["text"] += "\n\n" + b["text"]
                    else:
                        items.append({"type": "text", "text": b["text"]})
                elif t == "thinking" and b.get("thinking", "").strip():
                    items.append({"type": "thinking", "text": b["thinking"]})
                elif t == "tool_use" and b.get("name") not in engine.QUIET_TOOLS:
                    name, inp = b.get("name", ""), b.get("input") or {}
                    if name == "mcp__workbench__show_artifact":
                        items.append({"type": "artifact", "id": b.get("id"), **engine.artifact_info(inp, e.get("cwd") or "")})
                        continue
                    if name == "mcp__workbench__show_table":
                        items.append({"type": "table", "id": b.get("id"), "title": inp.get("title", ""),
                                      "columns": inp.get("columns") or [], "rows": inp.get("rows") or [], "note": inp.get("note", "")})
                        continue
                    tools[b.get("id")] = len(items)
                    items.append({"type": "tool", "id": b.get("id"), "name": name, "label": engine.tool_label(name, inp),
                                  "input": json.dumps(inp, indent=1, ensure_ascii=False)[:4000],
                                  "command": inp.get("command") if name == "Bash" else None, "ok": True, "output": "", **engine.agent_info(name, inp)})
    items += [{"type": "switch", "text": m.get("text", "")} for m in marks]  # after the last saved message
    return items[-max_items:]


SCRATCH = ("/tmp", "/private/tmp", "/private/var", str(Path.home() / ".t3"), str(Path.home() / "Pip" / "agents"))


def is_scratch(cwd: str) -> bool:
    return cwd.startswith(SCRATCH)


def group_by_repo(sessions: list[dict]) -> list[dict]:
    """[{cwd, name, sessions}] ordered by each folder's latest activity; throwaway folders (tmp, agent scratch
    dirs) go together in one Scratch group at the end."""
    groups: dict[str, dict] = {}
    scratch = {"cwd": "", "name": "Scratch", "short": "tmp and agent folders", "scratch": True, "sessions": []}
    for s in sessions:
        if is_scratch(s["cwd"]):
            scratch["sessions"].append(s)
            continue
        home = s["cwd"].rstrip("/") == str(Path.home())
        g = groups.setdefault(s["cwd"], {"cwd": s["cwd"], "name": "Home" if home else os.path.basename(s["cwd"].rstrip("/")),
                                         "short": engine.short(s["cwd"]), "sessions": []})
        g["sessions"].append(s)
    return list(groups.values()) + ([scratch] if scratch["sessions"] else [])


WHERE = {"claude-vscode": "VS Code", "cli": "the terminal", "sdk-cli": "Tether"}


def last_writer(sid: str) -> str:
    """Where the newest message in a saved session came from (VS Code, the terminal, ...)."""
    f = find_file(sid)
    if not f:
        return ""
    try:
        _, tail = _head_tail(f, 64_000)
    except OSError:
        return ""
    for line in reversed(tail):
        if '"entrypoint"' in line and ('"type":"user"' in line or '"type":"assistant"' in line):
            try:
                e = json.loads(line)
            except ValueError:
                continue
            return WHERE.get(e.get("entrypoint", ""), "another app")
    return ""


def activity(sid: str) -> dict:
    """Who wrote this session last and how many seconds ago (for the "it's open in VS Code" guard)."""
    f = find_file(sid)
    if not f:
        return {"where": "", "ago": None}
    try:
        ago = time.time() - f.stat().st_mtime
    except OSError:
        return {"where": "", "ago": None}
    return {"where": last_writer(sid), "ago": round(ago)}


# What's been worked out from a transcript (stats, artifacts, repos), kept on disk too, so opening a chat with many
# fresh starts reads each finished session once ever, not once per run of Tether.
_DISK = Path(os.environ["ANVIL_RECALL_DIR"]).parent / "cache" if os.environ.get("ANVIL_RECALL_DIR") else \
    next((p for p in (Path.home() / "Library/Application Support" / n for n in ("Tether", "Anvil")) if p.is_dir()),
         Path.home() / "Library/Application Support/Tether") / "cache"


def disk_get(kind: str, name: str):
    try:
        return json.loads((_DISK / kind / f"{name}.json").read_text())
    except (OSError, ValueError):
        return None


def disk_put(kind: str, name: str, value) -> None:
    try:
        p = _DISK / kind / f"{name}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False))
        tmp.replace(p)
    except OSError:
        pass  # only a speed-up


_art_cache: dict[str, tuple[int, dict]] = {}  # sid -> (bytes read so far, {path: artifact})


def artifacts_in(sid: str) -> list[dict]:
    """Files this session showed with show_artifact, oldest first, one per path (its latest title). Reads only
    what was added since the last call, so a long session isn't re-read after every reply."""
    f = find_file(sid)
    if not f:
        return []
    size = f.stat().st_size
    if sid not in _art_cache and (d := disk_get("artifacts", sid)):
        _art_cache[sid] = (d["done"], d["seen"])
    done, seen = _art_cache.get(sid, (0, {}))
    if size < done:  # rewritten (slimmed): start over
        done, seen = 0, {}
    if size == done:
        return list(seen.values())
    seen = dict(seen)
    pos = done
    with f.open("rb") as fb:
        fb.seek(done)
        for raw in fb:
            if not raw.endswith(b"\n"):  # a line still being written: read it next time
                break
            pos += len(raw)
            if b"mcp__workbench__show_artifact" not in raw or b'"tool_use"' not in raw:
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            if e.get("isSidechain"):
                continue
            for b in (e.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "mcp__workbench__show_artifact":
                    a = engine.artifact_info(b.get("input") or {}, e.get("cwd") or "")
                    seen.pop(a["path"], None)
                    seen[a["path"]] = {**a, "ts": e.get("timestamp", "")}
    _art_cache[sid] = (pos, seen)
    disk_put("artifacts", sid, {"done": pos, "seen": seen})
    return list(seen.values())


_stats_cache: dict[str, tuple[tuple, dict]] = {}


def stats(sid: str) -> dict:
    """Analytics for one session from its saved file: cost and tokens (Claude Code's own running total, which
    carries over when the session is resumed elsewhere), compactions, turns, tools, files, models, where it ran."""
    f = find_file(sid)
    if not f:
        return {"error": "This session hasn't been saved yet. Send a message first."}
    st = f.stat()
    key = (st.st_mtime, st.st_size)
    hit = _stats_cache.get(sid)
    if hit and hit[0] == key:
        return hit[1]
    d = disk_get("stats", sid)
    if d and d.get("key") == list(key):
        _stats_cache[sid] = (key, d["v"])
        return d["v"]
    cost = None
    turns = assistant_msgs = errors = 0
    compacts: list[str] = []
    tools: dict[str, int] = {}
    models: dict[str, int] = {}
    where: dict[str, int] = {}
    files: dict[str, int] = {}
    first = last = ""
    context = 0
    with f.open(errors="replace") as fh:
        for line in fh:
            if not line.startswith("{"):
                continue
            if '"cost-state"' in line[:40]:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if cost is None or (e.get("totalCostUSD") or 0) >= (cost.get("totalCostUSD") or 0):
                    cost = e
                continue
            if '"compact_boundary"' in line or '"isCompactSummary":true' in line:
                if '"compact_boundary"' in line:
                    try:
                        compacts.append(json.loads(line).get("timestamp", ""))
                    except ValueError:
                        pass
                continue
            is_user, is_asst = '"type":"user"' in line, '"type":"assistant"' in line
            if not (is_user or is_asst):
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("isSidechain"):
                continue
            ts = e.get("timestamp", "")
            first = first or ts
            last = ts or last
            msg = e.get("message") or {}
            content = msg.get("content")
            if is_user:
                if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                    errors += sum(1 for b in content if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"))
                elif not e.get("isMeta"):
                    t = _text_of(content).strip()
                    if t and not t.startswith(SKIP_PREFIXES):
                        turns += 1
                        w = WHERE.get(e.get("entrypoint", ""), "other")
                        where[w] = where.get(w, 0) + 1
                continue
            assistant_msgs += 1
            m = msg.get("model") or ""
            if m and m != "<synthetic>":
                models[m] = models.get(m, 0) + 1
            u = msg.get("usage") or {}
            ctx = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
            if ctx:
                context = ctx
            for b in content if isinstance(content, list) else []:
                if b.get("type") == "tool_use":
                    n = b.get("name", "")
                    tools[n] = tools.get(n, 0) + 1
                    p = (b.get("input") or {}).get("file_path")
                    if n in ("Write", "Edit", "MultiEdit", "NotebookEdit") and p:
                        files[p] = files.get(p, 0) + 1
    out = {"id": sid, "first": first, "last": last, "turns": turns, "assistant_messages": assistant_msgs,
           "tool_errors": errors, "compactions": len(compacts), "last_compaction": compacts[-1] if compacts else "",
           "context": context, "tools": sorted(tools.items(), key=lambda x: -x[1]),
           "models": sorted(models.items(), key=lambda x: -x[1]), "where": sorted(where.items(), key=lambda x: -x[1]),
           "files": [{"path": p, "short": engine.short(p), "edits": n} for p, n in sorted(files.items(), key=lambda x: -x[1])[:15]],
           "files_total": len(files), "file_edits": files, "size_mb": round(st.st_size / 1e6, 1)}
    if cost:
        mu = cost.get("modelUsage") or {}
        out["cost"] = {"usd": cost.get("totalCostUSD"), "api_ms": cost.get("totalAPIDuration"), "tool_ms": cost.get("totalToolDuration"),
                       "wall_ms": cost.get("totalDuration"), "lines_added": cost.get("totalLinesAdded"),
                       "lines_removed": cost.get("totalLinesRemoved"), "unknown_model_cost": cost.get("hasUnknownModelCost"),
                       "models": [{"model": k, "usd": v.get("costUSD"), "input": v.get("inputTokens"), "output": v.get("outputTokens"),
                                   "thinking": v.get("thinkingTokens"), "cache_read": v.get("cacheReadInputTokens"),
                                   "cache_write": v.get("cacheCreationInputTokens"), "web_searches": v.get("webSearchRequests")}
                                  for k, v in sorted(mu.items(), key=lambda kv: -(kv[1].get("costUSD") or 0))]}
    _stats_cache[sid] = (key, out)
    disk_put("stats", sid, {"key": list(key), "v": out})
    return out


def base_model(model: str) -> str:
    """claude-opus-5-5[1m] -> claude-opus-5-5, so the live id and the saved one match."""
    return (model or "").split("[")[0]


def turn_ended(sid: str) -> bool:
    """True when the last main-thread message is a finished reply from Claude (stop_reason end_turn), not a tool call,
    a tool result or a message of yours still waiting for its answer. Read from the end of the file."""
    f = find_file(sid)
    if not f:
        return False
    try:
        with open(f, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 2_000_000))
            lines = fh.read().splitlines()
    except OSError:
        return False
    for raw in reversed(lines):
        if b'"type":"user"' not in raw and b'"type":"assistant"' not in raw:
            continue
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(e, dict) or e.get("isSidechain") or e.get("isMeta") or e.get("type") not in ("user", "assistant"):
            continue
        return e["type"] == "assistant" and (e.get("message") or {}).get("stop_reason") == "end_turn"
    return False


def last_message_time(sid: str) -> float:
    """Epoch seconds of the last main-thread message (yours or Claude's), read from the end of the file; 0 if none."""
    f = find_file(sid)
    if not f:
        return 0.0
    try:
        with open(f, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 2_000_000))
            lines = fh.read().splitlines()
    except OSError:
        return 0.0
    from datetime import datetime
    for raw in reversed(lines):
        if b'"timestamp"' not in raw or (b'"type":"user"' not in raw and b'"type":"assistant"' not in raw):
            continue
        try:
            e = json.loads(raw)
            if e.get("isSidechain") or e.get("type") not in ("user", "assistant"):
                continue
            return datetime.fromisoformat(e["timestamp"].replace("Z", "+00:00")).timestamp()
        except (ValueError, KeyError):
            continue
    return 0.0


def last_context(sid: str) -> tuple[int, str]:
    """(tokens in context, model) at the last main-thread reply, read from the end of the file only."""
    f = find_file(sid)
    if not f:
        return 0, ""
    try:
        with open(f, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - 3_000_000))
            lines = fh.read().splitlines()
    except OSError:
        return 0, ""
    after_compact = 0  # a compaction since the last reply: its size is what's left; keep looking for the model
    for raw in reversed(lines):
        if b'"usage"' not in raw and b'"compact_boundary"' not in raw:
            continue
        try:
            e = json.loads(raw)
        except ValueError:
            continue
        if e.get("subtype") == "compact_boundary":
            after_compact = after_compact or (e.get("compactMetadata") or {}).get("postTokens") or 1
            continue
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        m = e.get("message") or {}
        u = m.get("usage") or {}
        tokens = sum(u.get(k) or 0 for k in ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")) + (u.get("output_tokens") or 0)
        if tokens and m.get("model") != "<synthetic>":
            return after_compact or tokens, m.get("model") or ""
    return after_compact, ""


def compaction_item(meta: dict, summary: str) -> dict:
    pre, post = meta.get("preTokens") or meta.get("pre_tokens"), meta.get("postTokens") or meta.get("post_tokens")
    return {"type": "compaction", "trigger": meta.get("trigger", ""), "pre": pre, "post": post,
            "summary": summary.split("\nSummary:", 1)[-1].strip() if summary else ""}


def last_compaction(sid: str) -> dict:
    """The newest compaction summary in a saved session, reading back from the end in chunks."""
    f = find_file(sid)
    if not f:
        return {}
    chunk, need = 8_000_000, b'"isCompactSummary":true'
    with open(f, "rb") as fh:
        fh.seek(0, 2)
        end = fh.tell()
        while end > 0:
            start = max(0, end - chunk)
            fh.seek(start)
            lines = fh.read(end - start + 200_000).splitlines()  # overlap so a line split at the edge is read whole
            hit = next((i for i in range(len(lines) - 1, -1, -1) if need in lines[i]), None)
            if hit is not None:
                try:
                    e = json.loads(lines[hit])
                except ValueError:
                    e = None
                if e:
                    meta = {}
                    for raw in reversed(lines[:hit]):
                        if b'"compact_boundary"' in raw:
                            try:
                                meta = json.loads(raw).get("compactMetadata") or {}
                            except ValueError:
                                pass
                            break
                    item = compaction_item(meta, _text_of((e.get("message") or {}).get("content")))
                    item["timestamp"] = e.get("timestamp", "")
                    return item
            end = start
    return {}


def _tag(text: str, name: str) -> str:
    a, b = f"<{name}>", f"</{name}>"
    return text.split(a, 1)[1].split(b, 1)[0].strip() if a in text and b in text else ""


BG_RE = re.compile(r"\A[^\n]{0,120}?with ID: (\w+)\. Output is being written to: (\S+?)\.?(?:\s|$)")


def _ts(stamp) -> float | None:
    try:
        return datetime.fromisoformat(str(stamp).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _agent_done(items: list[dict], tools: dict[str, int], text: str, stamp=None) -> None:
    import html
    use = _tag(text or "", "tool-use-id")
    if use in tools and items[tools[use]].get("job"):  # the same note is saved several times; the first says when
        j = items[tools[use]]["job"]
        if j["ended"] is None:
            j["status"] = _tag(text, "status") or "completed"
            j["summary"] = html.unescape(_tag(text, "summary"))[:1000]
            j["ended"] = _ts(stamp)
            m = re.search(r"exit code (-?\d+)", j["summary"])
            j["exit"] = int(m.group(1)) if m else None
        return
    if use in tools and items[tools[use]].get("agent"):
        it = items[tools[use]]
        it["status"] = _tag(text, "status") or "completed"
        it["summary"] = html.unescape(_tag(text, "summary"))[:4000]
        res = _tag(text, "result")
        if res:
            it["output"] = html.unescape(res)[:3000]


def agent_trail(sid: str, agent_id: str, limit: int = 400) -> dict:
    """A sub-agent's steps and final reply, from its own file next to the session (…/<sid>/subagents/agent-<id>.jsonl)."""
    f = find_file(sid)
    if not f or not agent_id or "/" in agent_id:
        return {"steps": [], "result": ""}
    path = f.parent / sid / "subagents" / f"agent-{agent_id}.jsonl"
    steps, result, handback = [], "", ""
    try:
        with path.open(errors="replace") as fh:
            for line in fh:
                if '"assistant"' not in line:
                    continue
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                for b in (e.get("message") or {}).get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use" and b.get("name") == "SubagentHandback":  # the report itself
                        handback = str((b.get("input") or {}).get("message") or "")
                    elif b.get("type") == "tool_use":
                        steps.append({"tool": b.get("name", ""), "text": engine.tool_label(b.get("name", ""), b.get("input") or {})})
                    elif b.get("type") == "text" and b.get("text", "").strip():
                        result = b["text"]
    except OSError:
        pass
    return {"steps": steps[-limit:], "total": len(steps), "result": handback or result}


def recent_talk(sid: str, limit: int = 40_000) -> str:
    """The last stretch of a session word for word, up to `limit` characters: my messages, Claude's replies, and one
    short line per tool call. Read backwards from the end of the file, so a long transcript costs no more than a short
    one. A carried-over handoff counts only for the message that came with it."""
    f = find_file(sid)
    if not f:
        return ""
    out, size = [], 0

    def take(e: dict) -> bool:  # False once full
        nonlocal size
        if e.get("type") not in ("user", "assistant") or e.get("isSidechain") or e.get("isMeta") or e.get("isCompactSummary"):
            return True
        c = (e.get("message") or {}).get("content")
        rows = []
        if e["type"] == "user":
            t = c if isinstance(c, str) else "\n".join(b.get("text", "") for b in c or [] if isinstance(b, dict) and b.get("type") == "text")
            if t.startswith(("[Tether handoff]", "[Anvil handoff]")):
                t = t.split("\n\n[Your message]\n", 1)[1] if "\n\n[Your message]\n" in t else ""
            if t.strip():
                rows.append(f"Me ({(e.get('timestamp') or '')[:16]}): {t.strip()}")
        else:
            for b in c if isinstance(c, list) else []:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    rows.append(f"Claude: {b['text'].strip()}")
                elif b.get("type") == "tool_use":
                    rows.append(f"  [ran {b.get('name')}: {json.dumps(b.get('input'), ensure_ascii=False)[:160]}]")
        for x in reversed(rows):
            if size + len(x) > limit:
                return False
            out.append(x); size += len(x) + 1
        return True

    block = 4 << 20
    with f.open("rb") as fh:
        pos = fh.seek(0, 2)
        rest = b""
        while pos > 0:
            step = min(block, pos)
            pos -= step
            fh.seek(pos)
            lines = (fh.read(step) + rest).split(b"\n")
            rest = lines.pop(0) if pos > 0 else b""  # may be cut; joined with the next block back
            for raw in reversed(lines):
                if b'"user"' not in raw and b'"assistant"' not in raw:
                    continue
                try:
                    e = json.loads(raw)
                except ValueError:
                    continue
                if isinstance(e, dict) and not take(e):
                    return "\n".join(reversed(out))
    return "\n".join(reversed(out))
