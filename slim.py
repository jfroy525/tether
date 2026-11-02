"""Slim a session transcript: drop screenshots and other embedded images from the part before the last compaction.

That part is no longer in Claude's context (Claude Code resumes from the last compaction), so resuming behaves the
same. Images after the last compaction are left alone. The original is kept as a gzip backup unless asked not to.
Most of a long session's size is images (often stored twice: in the message and in Claude Code's copy of the tool
result), so this usually removes most of the file.
"""
from __future__ import annotations

import gzip
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path

B64 = re.compile(r"^[A-Za-z0-9+/=\s]{2000,}$")
NOTE = "[image removed by Tether to save space; the original is in the backup]"


def _scrub(x):
    """Replace image blocks and long base64 strings anywhere in an entry. Returns (new value, bytes saved)."""
    if isinstance(x, dict):
        if x.get("type") == "image" and isinstance(x.get("source"), dict) and x["source"].get("type") == "base64":
            return {"type": "text", "text": NOTE}, len(x["source"].get("data") or "")
        saved, out = 0, {}
        for k, v in x.items():
            out[k], s = _scrub(v)
            saved += s
        return out, saved
    if isinstance(x, list):
        saved, out = 0, []
        for v in x:
            nv, s = _scrub(v)
            out.append(nv); saved += s
        return out, saved
    if isinstance(x, str) and len(x) > 2000 and B64.match(x[:5000]):
        return NOTE, len(x)
    return x, 0


def plan(path: Path) -> dict:
    """What slimming would do (reads only)."""
    size, last_boundary, n = path.stat().st_size, -1, 0
    with open(path, "rb") as fh:
        for i, raw in enumerate(fh):
            n = i + 1
            if b'"compact_boundary"' in raw and b'"subtype":"compact_boundary"' in raw.replace(b" ", b""):
                last_boundary = i
    saved = 0
    if last_boundary > 0:
        with open(path, "rb") as fh:
            for i, raw in enumerate(fh):
                if i >= last_boundary:
                    break
                if len(raw) < 3000 or (b'"image"' not in raw and b'base64' not in raw):
                    continue
                try:
                    _, s = _scrub(json.loads(raw))
                except ValueError:
                    continue
                saved += s
    return {"size": size, "lines": n, "last_compaction_line": last_boundary + 1, "removable": saved}


def slim(path: Path, backup_dir: Path | None, out: Path | None = None) -> dict:
    """Write the slimmed transcript (to `out`, or in place after backing up). Every line is checked to parse."""
    p = plan(path)
    if p["last_compaction_line"] <= 0:
        return {**p, "skipped": "never compacted, nothing safe to remove"}
    stop = p["last_compaction_line"] - 1
    fd, tmp = tempfile.mkstemp(dir=str((out or path).parent), suffix=".slim")
    saved = 0
    with os.fdopen(fd, "wb") as w, open(path, "rb") as fh:
        for i, raw in enumerate(fh):
            if i < stop and len(raw) >= 3000 and (b'"image"' in raw or b"base64" in raw):
                try:
                    e = json.loads(raw)
                    e, s = _scrub(e)
                    if s:
                        saved += s
                        raw = (json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
                except ValueError:
                    pass
            w.write(raw)
    with open(tmp, "rb") as fh:  # every line must still be valid JSON
        for raw in fh:
            json.loads(raw)
    if out:
        os.replace(tmp, out)
    else:
        if backup_dir:
            backup_dir.mkdir(parents=True, exist_ok=True)
            with open(path, "rb") as src, gzip.open(backup_dir / f"{path.stem}.{time.strftime('%Y%m%d-%H%M%S')}.jsonl.gz", "wb", 6) as dst:
                shutil.copyfileobj(src, dst)
        st = path.stat()
        os.replace(tmp, path)
        os.utime(path, (st.st_atime, st.st_mtime))  # keep its place in "recent"
    return {**p, "removed": saved, "new_size": (out or path).stat().st_size}
