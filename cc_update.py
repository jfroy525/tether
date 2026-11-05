"""Claude Code updates: compare the installed version with the newest one on npm, and run `claude update`
(which uses whatever installed it: Homebrew, npm or the native installer)."""
from __future__ import annotations

import json
import re
import subprocess
import time
import urllib.request

import engine
import repos

EVERY = 3600
LATEST_URL = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest"
_last: dict = {"at": 0.0, "res": None}


def _ver(text: str) -> tuple[int, ...]:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else ()


def installed(binary: str) -> str:
    try:
        out = subprocess.run([binary, "--version"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""
    v = _ver(out)
    return ".".join(map(str, v)) if v else ""


def status(binary: str | None, force: bool = False) -> dict:
    """{ok, installed, latest, newer} or {ok: False, why}."""
    if not binary:
        return {"ok": False, "why": "Claude Code isn't installed"}
    if not force and _last["res"] and time.time() - _last["at"] < EVERY:
        return _last["res"]
    have = installed(binary)
    try:
        with urllib.request.urlopen(LATEST_URL, timeout=10) as r:
            latest = json.load(r).get("version", "")
    except Exception:  # noqa: BLE001 - offline, proxy, npm down
        latest = ""
    res = {"ok": bool(have), "installed": have, "latest": latest,
           "newer": bool(have and latest and _ver(latest) > _ver(have)), "checked": time.time()}
    if not have:
        res["why"] = "Couldn't read Claude Code's version"
    _last.update(at=time.time(), res=res)
    return res


def update(binary: str) -> dict:
    """Run `claude update`; afterwards Tether forgets which options the old version refused."""
    env = {"PATH": repos.ENV_PATH, "HOME": str(__import__("pathlib").Path.home())}
    try:
        p = subprocess.run([binary, "update"], capture_output=True, text=True, timeout=600, env={**__import__("os").environ, **env})
    except subprocess.TimeoutExpired:
        return {"ok": False, "why": "The update took over 10 minutes and was stopped"}
    except OSError as exc:
        return {"ok": False, "why": str(exc)}
    out = " ".join(l.strip() for l in (p.stdout + "\n" + p.stderr).splitlines() if l.strip())[-400:]
    engine._help_cache.pop(binary, None)
    engine._unknown_flags.pop(binary, None)
    _last.update(at=0.0, res=None)
    now = installed(binary)
    return {"ok": p.returncode == 0, "installed": now, "why": "" if p.returncode == 0 else (out or f"claude update stopped with code {p.returncode}"),
            "output": out}
