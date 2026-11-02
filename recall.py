"""Recall: look things up in a long session's full history instead of keeping it all in context.

Each session gets a small SQLite full-text index built from its transcript: what you and Claude said, tool calls,
the start and end of tool output, every compaction summary and every sub-agent's report. Images (most of a
transcript's size) are left out. The index is updated incrementally from where it last stopped, so keeping it
fresh costs nothing but a file read.

search() returns ranked passages. ask() goes one step further: a small model (Haiku by default) reads the best
passages and answers in a few lines with where each fact came from, so the main session only takes in the answer.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import subprocess
import time
from pathlib import Path

import history

# ANVIL_RECALL_DIR lets a test run keep its indexes, notes and links away from your real ones
_SUPPORT = next((p for p in (Path.home() / "Library/Application Support" / n for n in ("Tether", "Anvil")) if p.is_dir()),
                Path.home() / "Library/Application Support/Tether")  # Anvil until Tether first opens and copies it
INDEX_DIR = Path(os.environ.get("ANVIL_RECALL_DIR") or _SUPPORT / "recall")
CHUNK, OVERLAP = 1600, 200
RESULT_HEAD, RESULT_TAIL = 2400, 600
STOP = set("""a an and are as at be but by can did do does for from had has have how i if in into is it its me my of on or
our so that the their them then there these they this to was we were what when where which who why will with would you your
about after again all also any been before being both could each just like more most much no not now only other over same
should some such than too under up very via want way well yes""".split())


LINEAGE = INDEX_DIR / "lineage.json"   # {new session: the session it continues}


def link(child: str, parent: str) -> None:
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    try:
        m = json.loads(LINEAGE.read_text())
    except (OSError, ValueError):
        m = {}
    m[child] = parent
    LINEAGE.write_text(json.dumps(m, indent=1))


def unlink(child: str) -> None:
    try:
        m = json.loads(LINEAGE.read_text())
    except (OSError, ValueError):
        return
    if m.pop(child, None) is not None:
        LINEAGE.write_text(json.dumps(m, indent=1))


_links: tuple = (None, {}, {})  # (lineage.json mtime, {child: parent}, {parent: [children]}), re-read when the file changes


def _maps() -> tuple[dict, dict]:
    global _links
    try:
        mt = LINEAGE.stat().st_mtime_ns
    except OSError:
        return {}, {}
    if _links[0] != mt:
        try:
            m = json.loads(LINEAGE.read_text())
        except (OSError, ValueError):
            m = {}
        kids: dict = {}
        for c, par in m.items():
            kids.setdefault(par, []).append(c)
        _links = (mt, m, kids)
    return _links[1], _links[2]


def parents_map() -> dict:
    return dict(_maps()[0])


def lineage(sid: str) -> list[str]:
    """This session, then the one it continues, and so on back to where the chat started (however long)."""
    m = _maps()[0]
    out, seen = [sid], {sid}
    while m.get(out[-1]) and m[out[-1]] not in seen:  # the check only guards against a loop in the links
        out.append(m[out[-1]]); seen.add(out[-1])
    return out


def moved_on(sid: str) -> bool:
    """True once a later session in the chat has its own transcript (a fresh start still waiting for its first
    message doesn't count): from then on this one is history, and if it's resumed it's a side branch."""
    return any(history.find_file(c) for c in _maps()[1].get(sid, []))


def notes_key(sid: str) -> str:
    """Which notes file a session reads and writes. Every session of a chat shares one, named after where the chat
    started; a lone session's own file simply becomes that when it gets a fresh start. A session resumed after the
    chat moved past it gets its own file (a side branch), so it can't write into the chat's notes."""
    chain = lineage(sid)
    if not moved_on(sid):
        return chain[-1]
    return f"{sid}.branch" if sid == chain[-1] else sid


def _db(sid: str, where: Path | None = None) -> sqlite3.Connection:
    d = where or INDEX_DIR
    d.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(d / f"{sid}.db")
    con.executescript("""
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, kind UNINDEXED, ts UNINDEXED, line UNINDEXED, src UNINDEXED,
            tokenize = "unicode61 tokenchars '_'");
    """)
    return con


def _chat_db(root: str, where: Path | None = None) -> sqlite3.Connection:
    """One index for a chat's finished sessions, so a lookup opens one file however many fresh starts it has had."""
    d = where or INDEX_DIR
    d.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(d / f"chat-{root}.db")
    con.executescript("""
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(text, kind UNINDEXED, ts UNINDEXED, line UNINDEXED, src UNINDEXED,
            sid UNINDEXED, tokenize = "unicode61 tokenchars '_'");
    """)
    return con


def merge_finished(sids: list[str], where: Path | None = None) -> int:
    """Fold a chat's finished sessions (all but the newest two, which lookups still re-check) into the chat index,
    then remove their own index files. Rows are copied as they are and counted before anything is removed. If an
    old session is indexed again later (resumed, or slimmed), its own file is searched instead and replaces its rows
    here at the next merge. Returns how many sessions were folded in."""
    if len(sids) < 3:
        return 0
    d = where or INDEX_DIR
    todo = [x for x in sids[2:] if (d / f"{x}.db").exists()]
    if not todo:
        return 0
    con = _chat_db(sids[-1], where)
    done = 0
    for x in reversed(todo):  # oldest first, so the chat index reads in order
        own = d / f"{x}.db"
        con.execute("ATTACH DATABASE ? AS o", (str(own),))
        try:
            with con:
                had = con.execute("SELECT 1 FROM meta WHERE k = ?", (f"merged:{x}",)).fetchone()
                if had:
                    con.execute("DELETE FROM chunks WHERE sid = ?", (x,))
                con.execute("INSERT INTO chunks (text, kind, ts, line, src, sid) SELECT text, kind, ts, line, src, ? FROM o.chunks ORDER BY rowid", (x,))
                want = con.execute("SELECT count(*) FROM o.chunks").fetchone()[0]
                got = con.execute("SELECT count(*) FROM chunks WHERE sid = ?", (x,)).fetchone()[0]
                if got != want:
                    raise sqlite3.DatabaseError(f"copied {got} of {want} rows for {x}")
                con.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (f"merged:{x}", str(got)))
        except sqlite3.DatabaseError:
            continue  # its own file stays and is searched as before
        finally:
            con.execute("DETACH DATABASE o")
        own.unlink(missing_ok=True)
        done += 1
    con.close()
    return done


def _strip(text: str) -> str:
    text = re.sub(r"<system-reminder>[\s\S]*?</system-reminder>", "", text)
    text = re.sub(r"data:image/[a-z]+;base64,[A-Za-z0-9+/=]{100,}", "[image]", text)
    return text.strip()


def _pieces(text: str):
    text = text.strip()
    if len(text) <= CHUNK:
        if text:
            yield text
        return
    i = 0
    while i < len(text):
        yield text[i:i + CHUNK]
        i += CHUNK - OVERLAP


def _tool_text(name: str, inp: dict) -> str:
    keep = {k: inp[k] for k in ("command", "description", "file_path", "pattern", "path", "query", "url", "prompt",
                                "skill", "statement", "sql") if k in inp}
    for k in ("old_string", "new_string", "content"):
        if k in inp:
            keep[k] = str(inp[k])[:1200]
    if not keep:
        keep = {k: (v if len(str(v)) < 600 else str(v)[:600]) for k, v in inp.items()}
    return f"{name}: " + json.dumps(keep, ensure_ascii=False)


def _result_text(content) -> str:
    if isinstance(content, str):
        t = content
    elif isinstance(content, list):
        t = "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    else:
        t = ""
    t = _strip(t)
    return t if len(t) <= RESULT_HEAD + RESULT_TAIL else t[:RESULT_HEAD] + "\n…\n" + t[-RESULT_TAIL:]


def _rows(e: dict, line: int, src: str):
    """(text, kind) rows worth indexing from one transcript entry."""
    ts = e.get("timestamp", "")
    t = e.get("type")
    if t == "queue-operation" and "<task-notification>" in str(e.get("content", "")):
        c = str(e["content"])
        summary = re.search(r"<summary>([\s\S]*?)</summary>", c)
        result = re.search(r"<result>([\s\S]*?)</result>", c)
        body = "\n".join(x.group(1) for x in (summary, result) if x)
        if body.strip():
            yield body, "agent", ts
        return
    if t not in ("user", "assistant") or e.get("isMeta"):
        return
    content = (e.get("message") or {}).get("content")
    if t == "user":
        if e.get("isCompactSummary"):
            text = content if isinstance(content, str) else _result_text(content)
            yield text.split("\nSummary:", 1)[-1], "summary", ts
            return
        if isinstance(content, str):
            text = _strip(content)
            if text and not text.startswith(("<command-", "<local-command", "Caveat:")):
                yield text, "user", ts
            return
        for b in content or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "text":
                text = _strip(b.get("text", ""))
                if text and not text.startswith(("<command-", "<local-command", "Caveat:", "<task-notification>")):
                    yield text, "user", ts
            elif b.get("type") == "tool_result":
                text = _result_text(b.get("content"))
                if text:
                    yield text, "result", ts
        return
    for b in content or []:
        if not isinstance(b, dict):
            continue
        k = b.get("type")
        if k == "text" and b.get("text", "").strip():
            yield b["text"], "claude", ts
        elif k == "thinking" and b.get("thinking", "").strip():
            yield b["thinking"], "thinking", ts
        elif k == "tool_use":
            if b.get("name") == "SubagentHandback":
                yield str((b.get("input") or {}).get("message", "")), "agent", ts
            else:
                yield _tool_text(b.get("name", ""), b.get("input") or {}), "tool", ts


def update(sid: str, where: Path | None = None) -> dict:
    """Bring the session's index up to date (only the part of the transcript added since last time)."""
    f = history.find_file(sid)
    if not f:
        return {"error": "no transcript"}
    con = _db(sid, where)
    meta = dict(con.execute("SELECT k, v FROM meta").fetchall())
    files = [("main", f)] + [(f"agent:{p.stem}", p) for p in sorted((f.parent / sid / "subagents").glob("agent-*.jsonl"))]
    added, t0 = 0, time.time()
    for src, path in files:
        key = f"off:{src}"
        off = int(meta.get(key, 0))
        size = path.stat().st_size
        if size < off:  # the file was rewritten (slimmed): its offsets no longer line up
            con.close()
            (where or INDEX_DIR).joinpath(f"{sid}.db").unlink(missing_ok=True)
            return update(sid, where)
        if size == off:
            continue
        line_no = int(meta.get(f"line:{src}", 0))
        with open(path, "rb") as fh:
            fh.seek(off)
            batch = []
            for raw in fh:
                if not raw.endswith(b"\n"):  # a line still being written: pick it up next time
                    break
                off += len(raw)
                line_no += 1
                if len(raw) > 40_000_000:
                    continue
                try:
                    e = json.loads(raw)
                except ValueError:
                    continue
                if e.get("isSidechain") and src == "main":
                    continue
                kind_src = src if src == "main" else src
                for text, kind, ts in _rows(e, line_no, src):
                    if src != "main" and kind not in ("agent", "claude"):
                        continue  # from sub-agents keep only what they concluded
                    if src != "main" and kind == "claude":
                        kind = "agent"
                    for piece in _pieces(text):
                        batch.append((piece, kind, ts, line_no, kind_src))
        con.executemany("INSERT INTO chunks (text, kind, ts, line, src) VALUES (?, ?, ?, ?, ?)", batch)
        con.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (key, str(off)))
        con.execute("INSERT OR REPLACE INTO meta VALUES (?, ?)", (f"line:{src}", str(line_no)))
        added += len(batch)
    con.commit()
    n = con.execute("SELECT count(*) FROM chunks").fetchone()[0]
    con.close()
    return {"added": added, "chunks": n, "seconds": round(time.time() - t0, 2)}


def _fts_query(q: str) -> str:
    words = [w for w in re.findall(r"[\w.\-/]+", q.lower()) if w not in STOP and len(w) > 1]
    terms = []
    for w in words:
        for part in re.split(r"[./\-]", w):  # match how the index splits paths and versions
            if part and part not in STOP:
                terms.append(f'"{part}"')
    return " OR ".join(dict.fromkeys(terms)) or '""'


def search(sids: list[str], query: str, k: int = 8, where: Path | None = None, raw_fts: str | None = None) -> list[dict]:
    """Best-matching passages across one or more sessions (newest first among equals)."""
    out, d = [], where or INDEX_DIR
    own = [x for x in sids if (d / f"{x}.db").exists()]  # sessions with their own index: the live ones
    for sid in own:
        try:
            con = _db(sid, where)
            rows = con.execute("SELECT text, kind, ts, line, src, bm25(chunks) FROM chunks WHERE chunks MATCH ? "
                               "ORDER BY bm25(chunks) LIMIT ?", (raw_fts or _fts_query(query), k * 3)).fetchall()
            con.close()
        except sqlite3.OperationalError:
            continue
        out += [{"sid": sid, "text": r[0], "kind": r[1], "ts": r[2], "line": r[3], "src": r[4], "score": r[5]} for r in rows]
    if len(sids) > 2 and (d / f"chat-{sids[-1]}.db").exists():  # the finished ones, all in one index
        allowed = set(sids) - set(own)
        try:
            con = _chat_db(sids[-1], where)
            rows = con.execute("SELECT text, kind, ts, line, src, sid, bm25(chunks) FROM chunks WHERE chunks MATCH ? "
                               "ORDER BY bm25(chunks) LIMIT ?", (raw_fts or _fts_query(query), k * 6)).fetchall()
            con.close()
        except sqlite3.OperationalError:
            rows = []
        out += [{"sid": r[5], "text": r[0], "kind": r[1], "ts": r[2], "line": r[3], "src": r[4], "score": r[6]}
                for r in rows if r[5] in allowed][:k * 3]
    # the best few notes always get a place: their scores come from a different index, so they don't compare
    picked = _note_matches(sids, raw_fts or _fts_query(query), min(4, max(1, k // 3)), where)
    # summaries and conclusions are denser than raw tool output: nudge them up a little
    weight = {"summary": 1.25, "agent": 1.2, "claude": 1.15, "user": 1.15, "thinking": 1.0, "tool": 0.9, "result": 0.85}
    out.sort(key=lambda r: r["score"] * weight.get(r["kind"], 1))
    seen = {r["text"][:160] for r in picked}
    for r in out:
        sig = r["text"][:160]
        if sig in seen:
            continue
        seen.add(sig)
        picked.append(r)
        if len(picked) >= k:
            break
    return picked


def _note_matches(sids: list[str], fts: str, k: int, where: Path | None) -> list[dict]:
    """The sessions' notes, archived ones included, searched like the transcript (word for word, as Haiku wrote them).
    A few thousand short lines: an in-memory index per lookup takes milliseconds."""
    import notes  # here, not at the top: notes imports this module
    seen, rows = set(), []
    for i in notes.load(sids[0], where).get("items", []) if sids else []:  # the chat's one file holds them all
        if i.get("status") != "dropped" and i["t"] not in seen:
            seen.add(i["t"])
            rows.append((f"[{i['s']}] {i['t']}", i.get("ts") or "", i.get("at") or 0, i.get("from") or sids[0]))
    if not rows:
        return []
    con = sqlite3.connect(":memory:")
    con.execute("CREATE VIRTUAL TABLE n USING fts5(text, ts UNINDEXED, line UNINDEXED, sid UNINDEXED, tokenize = \"unicode61 tokenchars '_'\")")
    con.executemany("INSERT INTO n VALUES (?, ?, ?, ?)", rows)
    try:
        got = con.execute("SELECT text, ts, line, sid, bm25(n) FROM n WHERE n MATCH ? ORDER BY bm25(n) LIMIT ?", (fts, k)).fetchall()
    except sqlite3.OperationalError:
        got = []
    con.close()
    return [{"sid": r[3], "text": r[0], "kind": "note", "ts": r[1], "line": r[2], "src": "notes", "score": r[4]} for r in got]


def max_rowid(sid: str, where: Path | None = None) -> int:
    con = _db(sid, where)
    n = con.execute("SELECT max(rowid) FROM chunks").fetchone()[0] or 0
    con.close()
    return n


def recent(sid: str, kinds=("user", "claude"), chars: int = 3500, where: Path | None = None) -> str:
    """The last few messages, newest last, up to about `chars` characters."""
    con = _db(sid, where)
    rows = con.execute(f"SELECT kind, ts, text FROM chunks WHERE kind IN ({','.join('?' * len(kinds))}) ORDER BY rowid DESC LIMIT 12",
                       kinds).fetchall()
    con.close()
    out, size = [], 0
    for kind, ts, text in rows:
        t = text[:1400]
        if size + len(t) > chars and out:
            break
        out.append(f"{'Me' if kind == 'user' else 'Claude'} ({ts[:16].replace('T', ' ')}): {t}")
        size += len(t)
    return "\n\n".join(reversed(out))


def cite(r: dict) -> str:
    return f"[{r['kind']} · {r['ts'][:16].replace('T', ' ')} · line {r['line']}]"


def format_passages(rows: list[dict], each: int = 700) -> str:
    return "\n\n".join(f"{cite(r)}\n{r['text'][:each]}" for r in rows) or "Nothing found."


# ----- the small-model step -----

ASK_SYSTEM = """You look things up in the saved history of a long Claude Code session for the assistant working in it.
You get a question and numbered passages from that history (oldest facts may be outdated; later passages win).
Answer only from the passages: the specific fact asked for (paths, IDs, numbers, commands, decisions and why), in at most
5 short lines. After each fact put its passage tag, like [claude · 2026-10-21 14:02 · line 1234]. If the passages don't
contain the answer, say "Not in the saved history" and name the closest thing you found. No preamble."""

QUERIES_SYSTEM = """You write search queries for a full-text index of a Claude Code session's history (messages, tool calls,
tool output, summaries). Given a question, reply with 3 short keyword queries, one per line, no numbering. Use the
distinctive words likely to appear in the text: file names, identifiers, error words, product names, synonyms."""


def claude_call(system: str, prompt: str, model: str = "haiku", timeout: int = 90) -> dict:
    """One lean `claude -p` call (no tools, no MCP, no settings): about 550 tokens of overhead."""
    cmd = [os.environ.get("ANVIL_CLAUDE", "claude"), "-p", "--model", model, "--system-prompt", system, "--tools", "",
           "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "",
           "--output-format", "json"]
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT")}
    env["PATH"] = os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"), env.get("PATH", "")])
    t0 = time.time()
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout, env=env, cwd=str(Path.home()))
    try:
        r = json.loads(p.stdout)
    except ValueError:
        return {"text": "", "cost": 0.0, "seconds": round(time.time() - t0, 1), "error": (p.stderr or p.stdout)[:300]}
    return {"text": (r.get("result") or "").strip(), "cost": r.get("total_cost_usd") or 0.0, "seconds": round(time.time() - t0, 1),
            "error": "" if not r.get("is_error") else r.get("result", "")}


def lookup(sid: str, question: str) -> str:
    """The recall tool: Haiku answers from the best passages; if it finds nothing, try again with better search words."""
    sids = lineage(sid)
    for s in sids[:2]:  # older sessions in the chain are finished and already indexed; checking them all grows with the thread
        update(s)
    merge_finished(sids)  # and folded into the chat's one index
    a = ask(sids, question)
    if a["text"].startswith("Not in the saved history"):
        b = ask(sids, question, expand=True)
        if not b["text"].startswith("Not in the saved history"):
            a = {**b, "cost": a["cost"] + b["cost"]}
    where = "this session" + (f" and {len(sids) - 1} earlier one{'s' if len(sids) > 2 else ''} it continues" if len(sids) > 1 else "")
    return f"{a['text']}\n\n(Searched {where}. Line numbers point into the saved transcript.)"


def ask(sids: list[str], question: str, model: str = "haiku", k: int = 14, expand: bool = False, where: Path | None = None) -> dict:
    """Search, then have a small model read the passages and answer briefly with sources."""
    cost, secs = 0.0, 0.0
    rows = search(sids, question, k=k, where=where)
    if expand:  # let the small model suggest better search words, and merge what they find
        q = claude_call(QUERIES_SYSTEM, question, model)
        cost += q["cost"]; secs += q["seconds"]
        extra = []
        for line in q["text"].splitlines()[:3]:
            if line.strip():
                extra += search(sids, line, k=6, where=where)
        seen = {r["text"][:160] for r in rows}
        rows += [r for r in extra if r["text"][:160] not in seen and not seen.add(r["text"][:160])]
    if not rows:
        return {"text": "Not in the saved history.", "cost": cost, "seconds": secs, "passages": 0}
    prompt = f"Question: {question}\n\nPassages:\n\n" + format_passages(rows, each=1100)
    a = claude_call(ASK_SYSTEM, prompt, model)
    return {"text": a["text"] or a.get("error", ""), "cost": cost + a["cost"], "seconds": round(secs + a["seconds"], 1), "passages": len(rows)}
