"""Tether updates itself from GitHub. A fetch every few hours says whether main has moved on; one click
fast-forwards this folder, installs new packages if requirements.txt changed, and restarts the app."""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

import repos

HERE = Path(__file__).resolve().parent
EVERY = 3600  # GitHub is asked at most this often, unless you check by hand
_last: dict = {"at": 0.0, "res": None}


def _git(*args: str, timeout: float = 30) -> tuple[int, str]:
    return repos._run(["git", *args], str(HERE), timeout)


def _fetch() -> str:
    """Ask GitHub for main; '' when it worked, else git's first error line (a proxy, no git tools, no network)."""
    env = {"PATH": f"{Path(repos.GIT).parent}:{repos.ENV_PATH}" if "/" in repos.GIT else repos.ENV_PATH,
           "HOME": str(Path.home()), "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": "ssh -oBatchMode=yes",
           **{k: v for k, v in os.environ.items() if k.lower() in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}}
    try:
        p = subprocess.run([repos.GIT, "fetch", "--quiet", "origin", "main"], cwd=HERE, env=env,
                           capture_output=True, text=True, timeout=45)
    except FileNotFoundError:
        return "git isn't installed"
    except subprocess.TimeoutExpired:
        return "GitHub didn't answer within 45 seconds"
    if p.returncode == 0:
        return ""
    lines = [l.strip() for l in (p.stderr or "").splitlines() if l.strip()]
    first = lines[0].removeprefix("fatal: ").removeprefix("error: ") if lines else f"git stopped with code {p.returncode}"
    return first[:200]


def current() -> str:
    """This copy's version, like '73ed16d · 2026-11-05'."""
    return _git("log", "-1", "--format=%h · %cs")[1].strip() if (HERE / ".git").exists() else ""


def parse_log(text: str) -> list[dict]:
    """CHANGELOG.md -> [{date, title, body}], newest first. Each entry starts '## YYYY-MM-DD · Title'."""
    out: list[dict] = []
    for line in (text or "").splitlines():
        if line.startswith("## "):
            date, _, title = line[3:].partition(" · ")
            out.append({"date": date.strip(), "title": title.strip() or date.strip(), "body": ""})
        elif out:
            out[-1]["body"] += line + "\n"
    for e in out:
        e["body"] = e["body"].strip()
        e["key"] = f"{e['date']} · {e['title']}"
    return out


def change_log() -> list[dict]:
    """This copy's change log."""
    try:
        return parse_log((HERE / "CHANGELOG.md").read_text())
    except OSError:
        return []


def _pending_log() -> list[dict]:
    """Entries in GitHub's change log that this copy doesn't have yet: what the update brings."""
    code, text = _git("show", "origin/main:CHANGELOG.md")
    if code:
        return []
    have = {e["key"] for e in change_log()}
    return [e for e in parse_log(text) if e["key"] not in have]


def pushed() -> bool:
    """Whether Tether's own files here match what was last pushed to GitHub's main: nothing changed, nothing new and
    no commit waiting to go up. Doesn't ask GitHub (a push updates origin/main here). A copy without git counts as pushed."""
    if not (HERE / ".git").exists():
        return True
    code, out = _git("status", "--porcelain", "--untracked-files=all", "--", "*.py", "ui/*.js", "ui/*.css", "ui/*.html", "markup.html", timeout=10)
    if code != 0 or out.strip():
        return False
    code, ahead = _git("rev-list", "--count", "origin/main..HEAD", timeout=10)
    return code == 0 and (ahead.strip() or "0") == "0"


def status(force: bool = False) -> dict:
    """{behind, ahead, dirty, changes}: commits on GitHub's main not here yet, and whether this copy can take them."""
    if not (HERE / ".git").exists():
        return {"ok": False, "why": "This copy wasn't installed with git clone, so it can't update itself.", "current": ""}
    if not force and _last["res"] and time.time() - _last["at"] < EVERY:
        return _last["res"]
    err = _fetch()
    if err:
        res = {"ok": False, "why": f"Couldn't reach GitHub: {err}", "current": current(), "checked": time.time()}
        if not _last["res"] or not _last["res"].get("ok"):
            _last.update(at=time.time(), res=res)
        return res
    n = lambda rng: int((_git("rev-list", "--count", rng)[1].strip() or "0"))  # noqa: E731
    behind, ahead = n("HEAD..origin/main"), n("origin/main..HEAD")
    dirty = bool(_git("status", "--porcelain", "--untracked-files=no")[1].strip())
    log = _git("log", "--format=%s", "HEAD..origin/main")[1].splitlines() if behind else []
    res = {"ok": True, "behind": behind, "ahead": ahead, "dirty": dirty, "changes": log[:12], "more": max(0, len(log) - 12),
           "notes": _pending_log() if behind else [],
           "current": current(), "checked": time.time()}
    _last.update(at=time.time(), res=res)
    return res


def _packages() -> bool:
    """Install what requirements.txt now lists into this folder's .venv (uv if it's there, else pip)."""
    py = HERE / ".venv" / "bin" / "python"
    py = str(py) if py.exists() else sys.executable
    req = str(HERE / "requirements.txt")
    env = {**os.environ, "PATH": f"{Path.home() / '.local/bin'}:{repos.ENV_PATH}"}
    uv = shutil.which("uv", path=env["PATH"])

    def run(*args: str) -> int:
        try:
            return subprocess.run(args, cwd=HERE, env=env, capture_output=True, timeout=900).returncode
        except (OSError, subprocess.TimeoutExpired):
            return 1
    if uv and run(uv, "pip", "install", "-q", "--python", py, "-r", req) == 0:
        return True
    run(py, "-m", "ensurepip", "-q")  # a venv made by uv has no pip of its own
    return run(py, "-m", "pip", "install", "-q", "-r", req) == 0


def apply() -> dict:
    """Move this folder to GitHub's main, which is the source of truth. Edits or commits made on this Mac are
    set aside first (a git stash and a tether-local-<time> branch), so nothing is lost; if a step fails, it goes back."""
    s = status(force=True)
    if not s.get("ok"):
        return {"error": s.get("why") or "Couldn't check for updates."}
    if not s.get("behind"):
        return {"error": "Tether is already up to date."}
    old = _git("rev-parse", "HEAD")[1].strip()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    if s.get("ahead"):
        _git("branch", f"tether-local-{stamp}", old)
    stashed = False
    if s.get("dirty"):
        if _git("stash", "push", "--quiet", "-m", f"Tether: set aside before update {stamp}")[0]:
            return {"error": "Couldn't set aside the changes made on this Mac. Nothing was changed."}
        stashed = True
    files = _git("diff", "--name-only", old, "origin/main")[1].split()

    def back() -> None:
        _git("reset", "--hard", "--quiet", old)
        if stashed:
            _git("stash", "pop", "--quiet")
    if _git("reset", "--hard", "--quiet", "origin/main")[0]:
        back()
        return {"error": "Couldn't apply the update. Nothing was changed."}
    if "requirements.txt" in files and not _packages():
        back()
        return {"error": "Couldn't install the new packages, so Tether stayed on the version you had."}
    _last["res"] = None
    return {"ok": True, "rebuild": "build_app.sh" in files}


def relaunch(rebuild: bool = False) -> None:
    """Once this process has quit, open Tether again (rebuilding the app first if the build script changed)."""
    app = os.environ.get("TETHER_APP") or str(Path.home() / "Applications" / "Tether.app")
    q = shlex.quote
    if Path(app).is_dir():
        build = f"APP_PATH={q(app)} zsh {q(str(HERE / 'build_app.sh'))} >/dev/null 2>&1; " if rebuild else ""
        start = f"{build}open {q(app)}"
    else:  # started from Terminal: start it the same way
        start = f"cd {q(str(HERE))} && nohup {q(sys.executable)} {q(str(HERE / 'workbench.py'))} >/dev/null 2>&1 &"
    script = f"while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.3; done; sleep 0.5; {start}"
    subprocess.Popen(["/bin/zsh", "-c", script], start_new_session=True,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
