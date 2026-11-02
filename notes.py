"""Notes per long session: decisions, exact facts, open items, gotchas and preferences, each with where it came from.

A small model (Haiku) keeps them up to date from the part of the conversation it hasn't read yet, reading the recall
index (recall.py) rather than the raw transcript. It replies with changes only (add / done / drop), never a rewrite,
so notes can't silently disappear. For an existing long session the first pass reads its compaction summaries (already
distilled) plus whatever came after the last one, not the whole thread.

All sessions of a chat (a chain of fresh starts) share one notes file, named after the session the chat started in,
so a long chat keeps one copy however many fresh starts it has. Each session's read position is kept in it. Chats from
before that (where every session held its own copy) are moved over the first time they're opened; the old copies stay
as they were. Writes take a lock, and the file before each write is kept as .prev (and once a day as .day).
"""
from __future__ import annotations

import fcntl
import json
import re
import shutil
import sqlite3
import threading
import time
from contextlib import contextmanager
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import recall

SECTIONS = ["Decisions", "Facts", "Open", "Gotchas", "Preferences"]
BATCH = 30_000          # characters of conversation per small-model call
WORKING = 40_000        # characters of notes a session works from (and a fresh session gets); the rest are archived
MAP = 5_000             # of those, kept for the archive map: one line per topic of the archived notes
KINDS = ("user", "claude", "summary", "agent")

SYSTEM = """You keep the notes for a long Claude Code session, so a fresh session can pick the work up without the history.
You get the current notes (each with an id) and the next part of the conversation (tagged with line numbers).
Reply with JSON only, no prose:
{"add": [{"s": "<section>", "t": "<one line>", "at": <line number>, "replaces": <id or null>}], "done": [<ids>], "drop": [<ids>]}
Sections:
- Decisions: what was decided and why, in a few words.
- Facts: exact paths, IDs, URLs, commands, versions, table names, people and what they own. Copy values exactly.
- Open: unfinished work, things waiting on someone, next steps.
- Gotchas: things that broke or misled, and what fixed them.
- Preferences: how the user wants things done (style, workflow, what to avoid).
Add only what a fresh session would need and isn't already in the notes. One line each, specific, no filler.
Each current note shows the date it was written. Before adding a note, look for an older note on the same thing: if
the new one changes a number, count, name, path, choice or status in it, set "replaces" to the older note's id.
done: ids of Open items that are now finished. drop: ids of notes that are now wrong or replaced with no new note.
At most 25 adds per reply. If nothing is worth keeping, reply {"add": [], "done": [], "drop": []}."""


TIDY = """You tidy the notes a Claude Code session inherited from the sessions it continues.
You get the notes (each with an id; lower ids are newer) and the last messages before the hand-off.
Reply with JSON only, no prose: {"done": [<ids>], "drop": [<ids>]}
- drop: notes that repeat another note in other words (keep the newer, more specific one), notes a newer note
  shows are wrong or replaced, and Open items that a newer Open item covers (the same step asked again later, such
  as several "reopen the app" or "confirm after reopening" items: keep only the newest).
- done: Open items that another note or the last messages show are finished.
Leave everything else alone. If nothing needs changing, reply {"done": [], "drop": []}."""


EMPTY = {"items": [], "last": 0, "updated": "", "cost": 0.0}


def _file(key: str, where: Path | None) -> Path:
    return (where or recall.INDEX_DIR) / f"{key}.notes.json"


def _read(f: Path) -> dict:
    try:
        return json.loads(f.read_text())
    except (OSError, ValueError):
        return json.loads(json.dumps(EMPTY))


def _write(f: Path, data: dict) -> None:
    f.parent.mkdir(parents=True, exist_ok=True)
    if f.exists():  # one step back always, and one a day
        shutil.copyfile(f, f.with_suffix(".prev.json"))
        day = f.with_suffix(".day.json")
        if not day.exists() or time.time() - day.stat().st_mtime > 86400:
            shutil.copyfile(f, day)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    tmp.replace(f)


_locks: dict = {}
_depth = threading.local()


@contextmanager
def _locked(f: Path):
    """One writer at a time per notes file: a thread lock inside Tether, a file lock against other processes."""
    key = str(f)
    lock = _locks.setdefault(key, threading.RLock())
    with lock:
        d = getattr(_depth, key, 0)
        setattr(_depth, key, d + 1)
        try:
            if d:
                yield
                return
            f.parent.mkdir(parents=True, exist_ok=True)
            with open(f.with_suffix(".lock"), "w") as fh:
                fcntl.flock(fh, fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(fh, fcntl.LOCK_UN)
        finally:
            setattr(_depth, key, d)


def _adopt(chain: list[str], f: Path, where: Path | None) -> None:
    """Move a chat from one copy per session to its shared file, once: the newest session's notes, plus anything
    older copies hold that it never took in. The first session's own old file is kept as .pre-chat."""
    with _locked(f):
        cur = _read(f) if f.exists() else None
        if cur and cur.get("chat"):
            return
        root = chain[-1]
        src = next((x for x in chain[:-1] if _file(x, where).exists() and _read(_file(x, where))["items"]), root)
        data = _read(_file(src, where))
        if src != root:
            if f.exists():
                shutil.copyfile(f, f.with_suffix(".pre-chat.json"))
            if not data.get("seeded"):  # it never took in what came before it
                seen = {_key(i["t"]) for i in data["items"] if i.get("status") != "dropped"}
                n = max((i["id"] for i in data["items"]), default=0)
                for x in chain[chain.index(src) + 1:]:
                    older = _read(_file(x, where))
                    for i in sorted(older["items"], key=lambda y: -y["id"]):
                        if i.get("status") in ("dropped", "done") or _key(i["t"]) in seen:
                            continue
                        seen.add(_key(i["t"])); n += 1
                        data["items"].append({**i, "id": n, "from": x, "status": "open"})
                    if older.get("seeded"):
                        break
        data.setdefault("read", {src: data.get("last", 0)})
        data.update(chat=True, seeded=True, tidied=True)
        _write(f, data)


def _home(sid: str, where: Path | None) -> Path:
    """This session's notes file (see recall.notes_key), set up the first time it's needed."""
    chain = recall.lineage(sid)
    key = recall.notes_key(sid)
    f = _file(key, where)
    if key == chain[-1]:
        if len(chain) > 1 or recall._maps()[1].get(sid):
            _adopt(chain, f, where)
    elif not f.exists():  # a side branch starts from the chat's notes as they are
        root = _file(chain[-1], where)
        chat = root if _read(root).get("chat") else next((_file(x, where) for x in chain[1:] if _file(x, where).exists()), root)
        with _locked(f):
            if not f.exists():
                data = _read(chat)
                data.update(read={}, chat=False, branch_of=chain[-1])
                _write(f, data)
    return f


def load(sid: str, where: Path | None = None) -> dict:
    return _read(_home(sid, where))


def save(sid: str, data: dict, where: Path | None = None) -> None:
    f = _home(sid, where)
    with _locked(f):
        _write(f, data)


@contextmanager
def txn(sid: str, where: Path | None = None):
    """Read, change and save the notes under the lock, so two sessions of a chat can't overwrite each other."""
    f = _home(sid, where)
    with _locked(f):
        data = _read(f)
        yield data
        _write(f, data)


def read_pos(data: dict, sid: str) -> int:
    r = data.get("read")
    return int(r.get(sid, 0)) if isinstance(r, dict) else int(data.get("last", 0))


def set_read(data: dict, sid: str, n: int) -> None:
    data.setdefault("read", {})[sid] = n
    data["last"] = n


def _key(t: str) -> str:
    t = t.lower().replace("colour", "color")
    return " ".join(re.sub(r"[^a-z0-9~/._-]+", " ", t).split())


def inherit(sid: str, where: Path | None = None) -> int:
    """Kept for callers: a fresh start used to copy in its parents' notes. The chat's shared file holds them now."""
    return 0


def _tidy(sid: str, data: dict, model: str, where: Path | None) -> float:
    """One small-model pass over freshly inherited notes: merge near-repeats, close finished to-dos."""
    carry = (where or recall.INDEX_DIR) / "carry" / f"{sid}.md"
    tail = carry.read_text().split("# Last messages", 1)[-1].split("\n\nUse recall for anything", 1)[0][-6000:] if carry.exists() else ""
    r = recall.claude_call(TIDY, f"Notes:\n{_numbered(data['items'])}\n\nLast messages before the hand-off:\n{tail or '(none)'}", model, timeout=180)
    m = re.search(r"\{[\s\S]*\}", r["text"] or "")
    try:
        ops = json.loads(m.group(0)) if m else {}
    except ValueError:
        ops = {}
    with txn(sid, where) as data:
        _apply(data, {"done": ops.get("done") or [], "drop": ops.get("drop") or []}, "")
        data["tidied"] = True
        data["cost"] = round(data.get("cost", 0.0) + r["cost"], 4)
        data["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    return r["cost"]


def _pending(sid: str, data: dict, where: Path | None) -> list[tuple[int, str]]:
    """(rowid, tagged text) of conversation the notes haven't read yet."""
    con = recall._db(sid, where)
    q = f"SELECT rowid, kind, ts, line, text FROM chunks WHERE rowid > ? AND kind IN ({','.join('?' * len(KINDS))}) ORDER BY rowid"
    last = read_pos(data, sid)
    if not last and not data["items"]:  # first pass on a long session: start from its summaries
        summaries = con.execute("SELECT rowid, kind, ts, line, text FROM chunks WHERE kind = 'summary' ORDER BY rowid").fetchall()
        if summaries:
            # the summaries themselves, then everything after the last one
            rows = summaries + con.execute(q, (summaries[-1][0], *KINDS)).fetchall()
            con.close()
            return [(r[0], f"[{r[1]} · {r[2][:16].replace('T', ' ')} · line {r[3]}]\n{r[4]}") for r in rows]
    rows = con.execute(q, (last, *KINDS)).fetchall()
    con.close()
    rows = [r for r in rows if not (r[1] == "user" and r[4].startswith(("[Tether handoff]", "[Anvil handoff]")))]  # carried-over notes, already kept
    return [(r[0], f"[{r[1]} · {r[2][:16].replace('T', ' ')} · line {r[3]}]\n{r[4]}") for r in rows]


def pending_chars(sid: str, where: Path | None = None) -> int:
    return sum(len(t) for _, t in _pending(sid, load(sid, where), where))


ORDER = ["Open", "Preferences", "Gotchas", "Decisions", "Facts"]  # what a fresh session needs most, first


def _live(items: list[dict]) -> list[dict]:
    return [i for i in items if i.get("status") != "dropped" and not (i["s"] == "Open" and i.get("status") == "done")]


def _working(items: list[dict], cap: int = WORKING) -> list[dict]:
    """The notes a session works from, up to `cap` characters: every Open item and Preference, then the newest of the
    rest whatever their section. The others stay in the file word for word (the archive), and recall searches them.
    Keeps every update and hand-off the same size however long the thread runs."""
    newest = lambda xs: sorted(xs, key=lambda x: (x.get("ts") or "", x["id"]), reverse=True)
    live = _live(items)
    first = newest(i for i in live if i["s"] in ("Open", "Preferences"))
    picked, size = [], 0
    for i in first + newest(i for i in live if i["s"] not in ("Open", "Preferences")):
        if size + len(i["t"]) + 3 > cap:
            continue
        picked.append(i); size += len(i["t"]) + 3
    return picked


def _numbered(items: list[dict]) -> str:
    return "\n".join(f"{i['id']}. [{i['s']} · {(i.get('ts') or '')[:10] or 'undated'}] {i['t']}" for i in _working(items)) or "(none yet)"


def _apply(data: dict, ops: dict, batch_ts: str) -> int:
    ids = {i["id"]: i for i in data["items"]}

    def nums(xs):  # Haiku sometimes sends {"id": 12} or "12" instead of 12
        for x in xs if isinstance(xs, list) else []:
            x = x.get("id") if isinstance(x, dict) else x
            try:
                yield int(x)
            except (TypeError, ValueError):
                continue
    ops = {**ops, "done": list(nums(ops.get("done"))), "drop": list(nums(ops.get("drop")))}
    for k in ops.get("done") or []:
        if k in ids and ids[k]["s"] == "Open":
            ids[k]["status"] = "done"
    for k in ops.get("drop") or []:
        if k in ids:
            ids[k]["status"] = "dropped"
    replaced = []  # dropped only once their replacement is actually added (not a repeat)
    n = max(ids, default=0)
    added = 0
    seen = {i["t"].strip().lower() for i in data["items"] if i.get("status") != "dropped"}
    for a in (ops.get("add") or [])[:25]:
        s, t = a.get("s"), str(a.get("t") or "").strip()
        if s not in SECTIONS or not t or t.lower() in seen:
            continue
        n += 1
        added += 1
        seen.add(t.lower())
        data["items"].append({"id": n, "s": s, "t": t[:400], "at": a.get("at"), "ts": batch_ts, "status": "open"})
        old = next(nums([a.get("replaces")]), None)
        if old in ids and ids[old].get("status") != "dropped":
            replaced.append((old, n))
    for old, new in replaced:
        ids[old]["status"] = "dropped"
        ids[old]["replaced_by"] = new
    return added


REPLACES = """You keep the notes of a long Claude Code session current. Each new note below is followed by older notes on
similar topics. For each new note, list the older notes it replaces: same subject, and the new note changes a number,
count, name, path, choice or status the older one gives, or shows it was undone. Don't list older notes that are only
related or that the new note adds detail to; when unsure, leave it out.
Reply with JSON only: {"<new id>": [<older ids>], ...} (empty lists can be left out)"""


def _words(t: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9][a-z0-9_./~-]+", t.lower()) if w not in recall.STOP and len(w) > 2}


def _supersede(data: dict, new_ids: list[int], model: str) -> float:
    """After new notes are added: find the few older notes most like each (shared rarer words, free), then one small
    call says which of those each new note replaces. Those are dropped, pointing at their replacement; the text stays
    in the file and the transcript stays in recall. Catches old notes the writer no longer has in mind."""
    live = [i for i in _live(data["items"]) if i["id"] not in new_ids]
    news = [i for i in data["items"] if i["id"] in new_ids and i.get("status") != "dropped"]
    if not live or not news:
        return 0.0
    words = {i["id"]: _words(i["t"]) for i in live}
    df = Counter(w for ws in words.values() for w in ws)
    rare = lambda w: 1.0 / (1 + df.get(w, 0))
    blocks = []
    for n in news:
        nw = _words(n["t"])
        scored = sorted(((sum(rare(w) for w in nw & words[i["id"]]), i) for i in live), key=lambda x: -x[0])
        close = [i for sc, i in scored[:5] if sc >= 0.5]
        if close:
            blocks.append(f"NEW {n['id']}. [{n['s']} · {(n.get('ts') or '')[:10]}] {n['t']}\n"
                          + "\n".join(f"  older {i['id']}. [{i['s']} · {(i.get('ts') or '')[:10]}] {i['t']}" for i in close))
    if not blocks:
        return 0.0
    r = recall.claude_call(REPLACES, "\n\n".join(blocks), model, timeout=180)
    m = re.search(r"\{[\s\S]*\}", r["text"] or "")
    try:
        got = json.loads(m.group(0)) if m else {}
    except ValueError:
        got = {}
    ids = {i["id"]: i for i in live}
    for k, olds in got.items() if isinstance(got, dict) else []:
        if not str(k).isdigit() or int(k) not in new_ids:
            continue
        for o in olds if isinstance(olds, list) else []:
            o = o.get("id") if isinstance(o, dict) else o
            if str(o).isdigit() and int(o) in ids and ids[int(o)].get("status") != "dropped":
                ids[int(o)]["status"], ids[int(o)]["replaced_by"] = "dropped", int(k)
    return r["cost"]


def update(sid: str, where: Path | None = None, model: str = "haiku", max_batches: int = 40, progress=None) -> dict:
    """Read what's new since the last update (in batches) and fold it into the notes."""
    recall.update(sid, where)
    inherit(sid, where)
    data = load(sid, where)
    cost, t0 = 0.0, time.time()
    if data.get("seeded") and not data.get("tidied"):
        cost += _tidy(sid, data, model, where)
    rows = _pending(sid, data, where)
    batches, added = 0, 0
    i = 0
    while i < len(rows) and batches < max_batches:
        chunk, size = [], 0
        while i < len(rows) and (size + len(rows[i][1]) <= BATCH or not chunk):
            chunk.append(rows[i]); size += len(rows[i][1]); i += 1
        prompt = f"Current notes:\n{_numbered(data['items'])}\n\nNext part of the conversation:\n\n" + "\n\n".join(t for _, t in chunk)
        r = recall.claude_call(SYSTEM, prompt, model, timeout=180)
        cost += r["cost"]; batches += 1
        m = re.search(r"\{[\s\S]*\}", r["text"] or "")
        try:
            ops = json.loads(m.group(0)) if m else {}
        except ValueError:
            ops = {}
        ts = re.search(r"· (\d{4}-\d\d-\d\d[ T]\d\d:\d\d)", chunk[-1][1])
        with txn(sid, where) as data:  # re-read: another session of the chat may have written meanwhile
            top = max((x["id"] for x in data["items"]), default=0)
            n_new = _apply(data, ops, ts.group(1) if ts else "")
            added += n_new
            if n_new:
                c = _supersede(data, [x["id"] for x in data["items"] if x["id"] > top], model)
                cost += c; data["cost"] = round(data.get("cost", 0.0) + c, 4)
            set_read(data, sid, chunk[-1][0])
            data["cost"] = round(data.get("cost", 0.0) + r["cost"], 4)
            data["updated"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        if progress:
            progress(i, len(rows))
    cost += label(sid, model, where)  # topics for newly archived notes, so the map is ready before any fresh start
    data = load(sid, where)
    return {"added": added, "batches": batches, "cost": round(cost, 4), "seconds": round(time.time() - t0, 1),
            "left": len(rows) - i, "total": len([x for x in data["items"] if x.get("status") != "dropped"])}


def edit(sid: str, op: str, value, where: Path | None = None) -> dict:
    """By hand: op add (value = {s, t}), drop (value = id), done (value = id)."""
    with txn(sid, where) as data:
        if op == "add":
            _apply(data, {"add": [{"s": value.get("s") or "Facts", "t": value.get("t"), "at": None}]}, time.strftime("%Y-%m-%d %H:%M"))
            data["items"][-1]["by"] = "you"
        elif op in ("drop", "done"):
            _apply(data, {op: [int(value)]}, "")
    return data


def render(sid: str, where: Path | None = None, with_done: bool = False) -> str:
    """The notes as markdown, by section."""
    items = load(sid, where)["items"]
    out = []
    for s in SECTIONS:
        rows = [i for i in items if i["s"] == s and i.get("status") != "dropped" and (with_done or i.get("status") != "done")]
        if rows:
            out.append(f"## {s}\n" + "\n".join(f"- {i['t']}" + (f" (line {i['at']})" if i.get("at") else "") for i in rows))
    return "\n\n".join(out)


# ----- the archive map -----

LABEL = """You sort the notes of a long Claude Code session into topics, so a fresh session can see what its archive holds.
You get notes (each with an id) and the topics already in use. Give each note a topic: reuse an existing topic when it
fits, otherwise make a new one. Topics are 2-5 words, specific to this project (a component, system or piece of work),
like "Login token refresh" or "CSV export format", never generic like "Misc" or "Bugs".
Reply with JSON only: {"<id>": "<topic>", ...}"""

VALUE = re.compile(
    r"https?://[^\s)\]]+|~?/?(?:[\w.@-]+/){1,}[\w.@-]+/?|\b[0-9a-f]{8,}\b|\$?\b\d[\d,]*(?:\.\d+)?(?:k|K|M|MB|GB|ms|s|%|x)?\b"
    r"|\b[A-Z]{2,}-\d+\b|\b\w+_\w+\b|\b[a-z]+[A-Z]\w*\b|`[^`]+`")


def _values(t: str) -> list[str]:
    """The exact values in a note (paths, IDs, URLs, identifiers), as written."""
    out = []
    for v in VALUE.findall(t):
        v = v.strip("`.,;:").rstrip("/")
        if v and not (v.isdigit() and len(v) < 3) and v not in out:
            out.append(v)
    return out


def _split(items: list[dict], cap: int) -> tuple[list[dict], list[dict]]:
    """(start notes, archived): if everything fits, all of it; otherwise MAP characters go to the archive map."""
    picked = _working(items, cap)
    if len(picked) == len(_live(items)):
        return picked, []
    picked = _working(items, cap - MAP)
    ids = {i["id"] for i in picked}
    return picked, [i for i in _live(items) if i["id"] not in ids]


def label(sid: str, model: str = "haiku", where: Path | None = None, least: int = 20, batch: int = 80) -> float:
    """Give a topic to archived notes that have none, once each, when at least `least` are waiting. Batches of `batch`
    run three at a time; topics found earlier are offered so they get reused."""
    data = load(sid, where)
    _, archived = _split(data["items"], WORKING)
    todo = [i for i in archived if not i.get("topic")]
    if len(todo) < least:
        return 0.0
    cost = 0.0
    chunks = [todo[k:k + batch] for k in range(0, len(todo), batch)]
    for g in range(0, len(chunks), 3):
        known = "\n".join(sorted({i["topic"] for i in data["items"] if i.get("topic")})[-150:]) or "(none yet)"

        def run(chunk):
            listing = "\n".join(f"{i['id']}. [{i['s']}] {i['t'][:300]}" for i in chunk)
            r = recall.claude_call(LABEL, f"Topics in use:\n{known}\n\nNotes:\n{listing}", model, timeout=150)
            m = re.search(r"\{[\s\S]*\}", r["text"] or "")
            try:
                return (json.loads(m.group(0)) if m else {}), r["cost"]
            except ValueError:
                return {}, r["cost"]

        with ThreadPoolExecutor(3) as pool:
            for chunk, (got, c) in zip(chunks[g:g + 3], pool.map(run, chunks[g:g + 3])):
                cost += c
                by_id = {i["id"]: i for i in chunk}
                for k, v in got.items():
                    if str(k).isdigit() and int(k) in by_id and isinstance(v, str) and v.strip():
                        by_id[int(k)]["topic"] = v.strip()[:60]
    topics = {i["id"]: i["topic"] for i in todo if i.get("topic")}
    with txn(sid, where) as fresh:
        for i in fresh["items"]:
            if i["id"] in topics and not i.get("topic"):
                i["topic"] = topics[i["id"]]
        fresh["cost"] = round(fresh.get("cost", 0.0) + cost, 4)
    return cost


def archive_map(archived: list[dict], cap: int = MAP - 120) -> str:
    """One line per topic of the archived notes, biggest and most recent first: how many notes, their dates, and a few
    exact values they hold, so a fresh session knows what's there and what to ask recall for."""
    groups = defaultdict(list)
    for i in archived:
        groups[i.get("topic") or "Not sorted yet"].append(i)
    rows = sorted(groups.items(), key=lambda kv: (len(kv[1]), max(x.get("ts") or "" for x in kv[1])), reverse=True)
    lines, size = [], 0
    for topic, xs in rows:
        common = Counter(v for x in xs for v in _values(x["t"]) if len(v) > 3 and not re.fullmatch(r"[\d,.$%]+", v))
        keys = ", ".join(v for v, _ in common.most_common(4))
        dates = sorted((x.get("ts") or "")[:10] for x in xs if x.get("ts"))
        when = f", {dates[0][5:]}–{dates[-1][5:]}" if dates else ""
        line = f"- {topic} ({len(xs)}{when}){': ' + keys if keys else ''}"
        if size + len(line) > cap:
            break
        lines.append(line); size += len(line) + 1
    more = f"\n- and {len(rows) - len(lines)} smaller topics" if len(rows) > len(lines) else ""
    return "## Archive (ask recall about any of these; it returns the notes word for word)\n" + "\n".join(lines) + more


def render_lineage(sids: list[str], cap: int = WORKING, where: Path | None = None) -> str:
    """The working notes of a session and the ones it continues, by section, newest first, up to `cap` chars, and a
    map of the archived rest (which recall searches). Finished open items are left out."""
    items = load(sids[0], where)["items"] if sids else []  # the chat's one file holds every session's notes
    picked, archived = _split(items, cap)
    out = []
    for s in ORDER:
        lines = [f"- {i['t']}" for i in picked if i["s"] == s]
        if lines:
            out.append(f"## {s}\n" + "\n".join(lines))
    if archived:
        out.append(archive_map(archived))
    return "\n\n".join(out)


# ----- notes for a fresh start: dated, and checked for what's done or replaced -----

STATUS = """You check the working notes of a long Claude Code session before they're handed to a fresh session.
Each note has an id, a section and the date it was written. For every note, give its state as of the newest date:
- "current": still true or still to do
- "done": an Open item that later notes show was finished
- "planned": a decision or fact describing something agreed but not yet built or applied, per the notes
- "superseded": a later note contradicts or replaces it (give the id of the newer note)
Judge only from the notes. When unsure, say "current". Reply with JSON only:
{"states": {"<id>": "current" | "done" | "planned" | ["superseded", <newer id>]}}"""


def status_pass(items: list[dict], model: str = "haiku") -> tuple[dict, float]:
    """{id: state} for the given notes, from one small-model pass (about a cent at 40k characters). Note text is never
    changed. On any failure every note counts as current."""
    listing = "\n".join(f"{i['id']}. [{i['s']} · {(i.get('ts') or '')[:10]}] {i['t']}" for i in items)
    try:
        r = recall.claude_call(STATUS, listing, model, timeout=300)
        txt = r["text"] or ""
        got = json.JSONDecoder().raw_decode(txt[txt.index("{"):])[0].get("states", {})
    except Exception:  # noqa: BLE001 - dated notes still go over without it
        return {}, 0.0
    ids = {i["id"] for i in items}
    out = {}
    for k, v in got.items() if isinstance(got, dict) else []:
        if not str(k).isdigit() or int(k) not in ids:
            continue
        if isinstance(v, list) and v and v[0] == "superseded":
            newer = v[1] if len(v) > 1 and str(v[1]).isdigit() else None
            if newer is not None and int(newer) in ids and int(newer) != int(k):
                out[int(k)] = ("superseded", int(newer))
        elif v in ("done", "planned"):
            out[int(k)] = (v, None)
    return out, r["cost"]


def render_fresh(sids: list[str], cap: int = WORKING, where: Path | None = None, model: str = "haiku") -> tuple[str, dict]:
    """Like render_lineage, for a fresh start: each note dated [MM-DD], and one status pass over the working notes.
    Replaced notes leave this hand-off, finished Open items show as (done), planned ones are tagged so they aren't
    taken as built. Only the hand-off changes: the stored notes stay as they are, and the next fresh start checks again.
    Returns (markdown, {"states": counts, "cost": cost})."""
    items = load(sids[0], where)["items"] if sids else []
    picked, archived = _split(items, cap)
    states, cost = status_pass(picked, model) if picked else ({}, 0.0)
    if cost and sids:
        with txn(sids[0], where) as d:
            d["cost"] = round(d.get("cost", 0.0) + cost, 4)
    tag = {"done": " (done)", "planned": " (planned, not built yet)"}
    out = ["Each note starts with the date it was written [MM-DD]; newer notes win."]
    for s in ORDER:
        lines = []
        for i in picked:
            k = states.get(i["id"], ("current", None))[0]
            if i["s"] != s or k == "superseded":
                continue
            when = (i.get("ts") or "")[5:10]
            lines.append(f"- {'[' + when + '] ' if when else ''}{i['t']}{tag.get(k, '')}")
        if lines:
            out.append(f"## {s}\n" + "\n".join(lines))
    if archived:
        out.append(archive_map(archived))
    return "\n\n".join(out), {"states": dict(Counter(k for k, _ in states.values())), "cost": round(cost, 4)}
