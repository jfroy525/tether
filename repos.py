"""
Repo status straight from git and gh (fast, no tokens): branch, changes, ahead/behind, the open PR and its
checks, file diffs, and which Databricks workspace the repo points at.
"""

from __future__ import annotations

import configparser
import json
import re
import subprocess
import time
from pathlib import Path

ENV_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
_pr_cache: dict[str, tuple[float, dict | None]] = {}


GIT = next((g for g in ("/opt/homebrew/bin/git", "/usr/local/bin/git", "/Library/Developer/CommandLineTools/usr/bin/git",
                         "/Applications/Xcode.app/Contents/Developer/usr/bin/git") if Path(g).exists()), "git")


def _run(args: list[str], cwd: str, timeout: float = 8) -> tuple[int, str]:
    if args and args[0] == "git":
        args = [GIT, *args[1:]]
    try:
        p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout,
                           env={"PATH": f"{Path(GIT).parent}:{ENV_PATH}" if "/" in GIT else ENV_PATH,  # gh runs git too: give it the same one
                                "HOME": str(Path.home()), "GIT_OPTIONAL_LOCKS": "0",
                                "GIT_TERMINAL_PROMPT": "0", "GIT_SSH_COMMAND": "ssh -oBatchMode=yes"})  # never wait on a password prompt
        return p.returncode, p.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""


def root(cwd: str) -> str | None:
    code, out = _run(["git", "rev-parse", "--show-toplevel"], cwd, 3)
    return out.strip() if code == 0 and out.strip() else None


def status(cwd: str) -> dict:
    """Branch, upstream, ahead/behind and changed files (porcelain v1)."""
    top = root(cwd)
    if not top:
        return {"git": False, "cwd": cwd}
    code, out = _run(["git", "status", "--porcelain=v1", "-b", "-uall"], top)
    lines = out.splitlines()
    head = lines[0][3:] if lines and lines[0].startswith("## ") else ""
    m = re.match(r"(?:No commits yet on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?", head)
    branch, upstream, track = (m.group(1), m.group(2) or "", m.group(3) or "") if m else (head, "", "")
    ahead = int(re.search(r"ahead (\d+)", track).group(1)) if "ahead" in track else 0
    behind = int(re.search(r"behind (\d+)", track).group(1)) if "behind" in track else 0
    files = []
    for l in lines[1:]:
        code_xy, path = l[:2], l[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        kind = ("untracked" if code_xy == "??" else "added" if "A" in code_xy else "deleted" if "D" in code_xy
                else "renamed" if "R" in code_xy else "modified")
        files.append({"path": path.strip('"'), "kind": kind, "staged": code_xy[0] not in (" ", "?")})
    _, remote = _run(["git", "remote", "get-url", "origin"], top, 3)
    return {"git": True, "cwd": cwd, "root": top, "name": Path(top).name, "branch": branch, "upstream": upstream,
            "ahead": ahead, "behind": behind, "gone": "gone" in track, "files": files, "remote": remote.strip(),
            "databricks": databricks_target(top)}


def pr(cwd: str, max_age: float = 90) -> dict | None:
    """The open PR for the current branch (via gh), cached for a minute and a half."""
    top = root(cwd) or cwd
    code, branch = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], top, 3)
    key = f"{top}@{branch.strip()}"
    hit = _pr_cache.get(key)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    code, out = _run(["gh", "pr", "view", "--json", "number,title,url,state,isDraft,baseRefName,statusCheckRollup,reviewDecision"],
                     top, 15)
    info = None
    if code == 0 and out.strip():
        try:
            d = json.loads(out)
            checks = d.get("statusCheckRollup") or []
            states = [str(c.get("conclusion") or c.get("state") or c.get("status") or "").upper() for c in checks]
            fail = sum(s in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT") for s in states)
            pend = sum(s in ("PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "") for s in states)
            info = {"number": d["number"], "title": d["title"], "url": d["url"], "state": d["state"],
                    "draft": d.get("isDraft"), "base": d.get("baseRefName"), "review": d.get("reviewDecision") or "",
                    "checks": {"total": len(states), "failed": fail, "pending": pend, "passed": len(states) - fail - pend}}
        except (ValueError, KeyError):
            info = None
    _pr_cache[key] = (time.time(), info)
    return info


def diff(cwd: str, path: str) -> dict:
    """One changed file against HEAD (untracked files show as all new)."""
    top = root(cwd) or cwd
    full = Path(top) / path
    code, before = _run(["git", "show", f"HEAD:{path}"], top, 5)
    before_text = before if code == 0 else None
    try:
        after = full.read_text(errors="replace") if full.is_file() and full.stat().st_size < 2_000_000 else None
    except OSError:
        after = None
    import engine
    return {"file": path, "short": path, **engine.make_diff(before_text, after)}


def log(cwd: str, n: int = 8) -> list[dict]:
    top = root(cwd) or cwd
    code, out = _run(["git", "log", f"-{n}", "--pretty=format:%h\x1f%s\x1f%an\x1f%cr"], top, 5)
    return [dict(zip(("hash", "subject", "author", "when"), l.split("\x1f"))) for l in out.splitlines() if l]


def _databricks_profiles() -> dict:
    cfg = configparser.ConfigParser()
    try:
        cfg.read(Path.home() / ".databrickscfg")
    except configparser.Error:
        return {}
    out = {s: dict(cfg[s]) for s in cfg.sections()}
    if cfg.defaults():
        out.setdefault("DEFAULT", dict(cfg.defaults()))
    return out


def databricks_target(top: str, override: str = "") -> dict | None:
    """Which workspace this repo works against: a bundle's default target, else the DEFAULT profile."""
    profiles = _databricks_profiles()
    profile, host = override, ""
    bundle = Path(top) / "databricks.yml"
    if not profile and bundle.exists():
        text = bundle.read_text(errors="replace")
        # The target marked `default: true`, else the first; its profile or host.
        targets = re.split(r"\n  (?=[\w-]+:\s*\n)", text.split("\ntargets:", 1)[1]) if "\ntargets:" in text else []
        chosen = next((t for t in targets if re.search(r"\bdefault:\s*true", t)), targets[0] if targets else "")
        m = re.search(r"\bprofile:\s*['\"]?([\w.-]+)", chosen) or re.search(r"\bprofile:\s*['\"]?([\w.-]+)", text)
        h = re.search(r"\bhost:\s*['\"]?(\S+?)['\"]?\s*$", chosen, re.M)
        profile = m.group(1) if m else ""
        host = h.group(1) if h else ""
    if not profile and not host:
        profile = "DEFAULT" if "DEFAULT" in profiles else ""
    host = host or profiles.get(profile, {}).get("host", "")
    if not profile and not host:
        return None
    label = re.sub(r"^https?://", "", host).split(".")[0] if host else ""
    return {"profile": profile, "host": host, "label": label}


SCAN_DIRS = ["~", "~/repos", "~/code", "~/src", "~/projects", "~/Developer", "~/GitHub", "~/Claude Outputs", "~/Documents", "~/Desktop"]
SKIP_DIRS = {"Library", "pinokio", "node_modules", ".venv", "Applications", "Music", "Movies", "Pictures", "Public",
             ".Trash", ".cache"}
_discovered: tuple[float, list] = (0.0, [])


def discover(max_age: float = 300) -> list[dict]:
    """Git repos under the usual folders (two levels deep), most recently touched first."""
    global _discovered
    if time.time() - _discovered[0] < max_age:
        return _discovered[1]
    found: dict[str, float] = {}
    for base in SCAN_DIRS:
        b = Path(base).expanduser()
        if not b.is_dir():
            continue
        level1 = [b] + [c for c in b.iterdir() if c.is_dir() and c.name not in SKIP_DIRS and not c.name.startswith((".", "OneDrive", "Dropbox", "Google Drive"))]
        for d in level1:
            kids = [d] if d == b else [d] + [c for c in d.iterdir() if c.is_dir() and c.name not in SKIP_DIRS and not c.name.startswith((".", "OneDrive", "Dropbox", "Google Drive"))] if d.is_dir() else []
            for c in kids:
                try:
                    g = c / ".git"
                    if g.exists() and c != Path.home():
                        idx = g / "index" if g.is_dir() else g
                        found[str(c)] = max(idx.stat().st_mtime if idx.exists() else 0, (g / "HEAD").stat().st_mtime if (g / "HEAD").exists() else 0)
                except (OSError, PermissionError):
                    continue
    out = [{"cwd": k, "name": Path(k).name, "mtime": v} for k, v in sorted(found.items(), key=lambda x: -x[1])]
    _discovered = (time.time(), out)
    return out


# ---------- Changes and History panels ----------

_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str, max_age: float, fn):
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < max_age:
        return hit[1]
    val = fn()
    _cache[key] = (time.time(), val)
    return val


def github_url(remote: str) -> str:
    """https://github.com/owner/repo for an https or ssh GitHub remote, else ""."""
    m = re.match(r"(?:https://(?:[^@/]+@)?github\.com/|git@github\.com:|ssh://git@github\.com/)([^/]+/[^/]+?)(?:\.git)?/?$", remote.strip())
    return f"https://github.com/{m.group(1)}" if m else ""


def default_branch(top: str) -> str:
    code, out = _run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], top, 3)
    return out.strip().split("/", 1)[-1] if code == 0 and out.strip() else ""


def _on_remote(top: str, branch: str) -> bool:
    return bool(branch) and _run(["git", "rev-parse", "--verify", "-q", f"refs/remotes/origin/{branch}"], top, 3)[0] == 0


def _numstat(top: str, args: list[str]) -> dict:
    code, out = _run(["git", "diff", "--numstat", *args], top, 8)
    res = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, d, path = parts
            if " => " in path:  # renames: "dir/{old => new}.py" or "old => new"
                path = re.sub(r"\{[^{}]* => ([^{}]*)\}", r"\1", path).split(" => ")[-1].replace("//", "/")
            res[path] = (None if a == "-" else int(a), None if d == "-" else int(d))
    return res


def changes(cwd: str) -> dict:
    """Uncommitted files with +/- lines, split staged / unstaged / untracked, the commits not pushed yet, and the
    GitHub links that exist for them."""
    st = status(cwd)
    if not st.get("git"):
        return st
    top = st["root"]
    staged, unstaged = _numstat(top, ["--cached"]), _numstat(top, [])
    for f in st["files"]:
        if f["kind"] == "untracked":
            try:
                p = Path(top) / f["path"]
                f["add"] = sum(1 for _ in p.open("rb")) if p.is_file() and p.stat().st_size < 2_000_000 else None
            except OSError:
                f["add"] = None
            f["del"] = 0
        else:
            a1, d1 = staged.get(f["path"], (0, 0))
            a2, d2 = unstaged.get(f["path"], (0, 0))
            f["add"] = None if a1 is None or a2 is None else a1 + a2
            f["del"] = None if d1 is None or d2 is None else d1 + d2
        f["group"] = "untracked" if f["kind"] == "untracked" else "staged" if f["staged"] else "unstaged"
    rng = [f"{st['upstream']}..HEAD"] if st["upstream"] else ["HEAD", "--not", "--remotes"]
    code, out = _run(["git", "log", "-30", "--pretty=format:%H\x1f%h\x1f%s\x1f%cr", *rng], top, 5)
    unpushed = [dict(zip(("sha", "short", "subject", "when"), l.split("\x1f"))) for l in out.splitlines() if l]
    gh = github_url(st["remote"])
    return {**st, "github": gh, "default": default_branch(top), "on_remote": _on_remote(top, st["branch"]), "unpushed": unpushed}


def graph(cwd: str, scope: str = "local", n: int = 60) -> dict:
    """Commits in topological order with parents and the branch/tag names on them, for the History tree.
    scope: current (this branch and its upstream, plus the default branch), local (every local branch), all."""
    top = root(cwd)
    if not top:
        return {"git": False}
    code, head = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], top, 3)
    head = head.strip()
    if scope == "all":
        refs = ["--all"]
    elif scope == "current":
        d = default_branch(top)
        refs = ["HEAD"] + [r for r in ("@{upstream}", f"origin/{d}" if d else "") if r and _run(["git", "rev-parse", "--verify", "-q", r], top, 3)[0] == 0]
    else:
        refs = ["HEAD", "--branches"]
    code, out = _run(["git", "log", "--topo-order", f"-{max(5, min(int(n), 1000))}", "--pretty=format:%H\x1f%P\x1f%s\x1f%an\x1f%cI\x1f%D", *refs], top, 10)
    commits = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) < 6:
            continue
        sha, parents, subject, author, at, deco = parts[:6]
        names = []
        for r in (x.strip() for x in deco.split(",") if x.strip()):
            if r.startswith("HEAD -> "):
                names.append({"name": r[8:], "kind": "head"})
            elif r == "HEAD":
                names.append({"name": "HEAD", "kind": "head"})
            elif r.startswith("tag: "):
                names.append({"name": r[5:], "kind": "tag"})
            elif r.endswith("/HEAD"):
                continue
            elif "/" in r and r.split("/", 1)[0] in ("origin", "upstream"):
                names.append({"name": r, "kind": "remote"})
            else:
                names.append({"name": r, "kind": "local"})
        commits.append({"sha": sha, "parents": parents.split(), "subject": subject, "author": author, "at": at, "refs": names})
    code, out = _run(["git", "log", "--remotes", "--format=%H", f"-{len(commits) * 3 + 50}"], top, 8)
    pushed = set(out.split())
    for c in commits:
        c["pushed"] = c["sha"] in pushed
    _, remote = _run(["git", "remote", "get-url", "origin"], top, 3)
    return {"git": True, "root": top, "head": head, "github": github_url(remote), "commits": commits}


def commit_files(cwd: str, sha: str) -> list[dict]:
    top = root(cwd) or cwd
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        return []
    _, names = _run(["git", "show", "--format=", "--name-status", "-M", sha], top, 8)
    kinds = {}
    for line in names.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2:
            k = parts[0][:1]
            kinds[parts[-1]] = {"A": "added", "D": "deleted", "R": "renamed"}.get(k, "modified")
    _, out = _run(["git", "show", "--format=", "--numstat", "-M", sha], top, 8)
    files = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, d, path = parts
            if " => " in path:
                path = re.sub(r"\{[^{}]* => ([^{}]*)\}", r"\1", path).split(" => ")[-1].replace("//", "/")
            files.append({"path": path, "add": None if a == "-" else int(a), "del": None if d == "-" else int(d), "kind": kinds.get(path, "modified")})
    return files


def commit_diff(cwd: str, sha: str, path: str) -> dict:
    top = root(cwd) or cwd
    if not re.fullmatch(r"[0-9a-f]{7,40}", sha):
        return {}
    code, before = _run(["git", "show", f"{sha}^:{path}"], top, 5)
    code2, after = _run(["git", "show", f"{sha}:{path}"], top, 5)
    import engine
    return {"file": path, "short": path, **engine.make_diff(before if code == 0 else None, after if code2 == 0 else None)}


def _gh_json(top: str, args: list[str], timeout: float = 20):
    code, out = _run(["gh", *args], top, timeout)
    try:
        return json.loads(out) if code == 0 and out.strip() else None
    except ValueError:
        return None


def pull_requests(top: str) -> list[dict]:
    def get():
        d = _gh_json(top, ["pr", "list", "--state", "all", "-L", "50", "--json",
                           "number,title,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeCommit,mergedAt,createdAt"]) or []
        return [{"number": p["number"], "title": p["title"], "url": p["url"], "state": "draft" if p.get("isDraft") and p["state"] == "OPEN" else p["state"].lower(),
                 "head": p.get("headRefOid") or "", "merge": (p.get("mergeCommit") or {}).get("oid") or "", "branch": p.get("headRefName") or "",
                 "base": p.get("baseRefName") or "", "at": p.get("mergedAt") or p.get("createdAt") or ""} for p in d]
    return _cached(f"prs:{top}", 120, get)


def action_runs(top: str) -> list[dict]:
    def get():
        d = _gh_json(top, ["run", "list", "-L", "60", "--json", "workflowName,displayTitle,headSha,headBranch,status,conclusion,url,createdAt,event"]) or []
        return [{"workflow": r.get("workflowName") or "", "title": r.get("displayTitle") or "", "sha": r.get("headSha") or "", "branch": r.get("headBranch") or "",
                 "state": (r.get("conclusion") or r.get("status") or "").lower(), "url": r.get("url") or "", "at": r.get("createdAt") or ""} for r in d]
    return _cached(f"runs:{top}", 120, get)


def github_deployments(top: str, gh: str) -> list[dict]:
    if not gh:
        return []
    slug = gh.split("github.com/", 1)[1]
    def get():
        d = _gh_json(top, ["api", f"repos/{slug}/deployments?per_page=40"]) or []
        out = []
        for x in d if isinstance(d, list) else []:
            out.append({"source": "github", "target": x.get("environment") or "deployment", "sha": x.get("sha") or "", "at": x.get("created_at") or "",
                        "state": "", "url": f"{gh}/deployments/{x.get('environment') or ''}"})
        rel = _gh_json(top, ["release", "list", "-L", "30", "--json", "tagName,name,publishedAt,isDraft"]) or []
        for r in rel:
            out.append({"source": "release", "target": r.get("name") or r.get("tagName"), "tag": r.get("tagName"), "at": r.get("publishedAt") or "",
                        "state": "draft" if r.get("isDraft") else "published", "url": f"{gh}/releases/tag/{r.get('tagName')}"})
        return out
    return _cached(f"ghdeploy:{top}", 300, get)


def databricks_apps(top: str) -> list[str]:
    """Databricks Apps this repo deploys: names in databricks.yml's apps, else the repo's name if it has an app.yaml."""
    names = []
    bundle = Path(top) / "databricks.yml"
    if bundle.exists():
        text = bundle.read_text(errors="replace")
        if "\n  apps:" in text or "\napps:" in text:
            names += re.findall(r"^\s+name:\s*['\"]?([a-z0-9][a-z0-9-]{1,30})['\"]?\s*$", text.split("apps:", 1)[1], re.M)[:3]
    if not names:
        for p in [Path(top) / "app.yaml", *Path(top).glob("*/app.yaml")]:
            if p.exists():
                names.append(Path(top).name.lower())
                break
    return names


def databricks_deploys(top: str, app: str, profile: str = "") -> list[dict]:
    def get():
        args = ["databricks", "apps", "list-deployments", app, "-o", "json"] + (["-p", profile] if profile and profile != "DEFAULT" else [])
        code, out = _run(args, top, 25)
        try:
            d = json.loads(out) if code == 0 else []
        except ValueError:
            d = []
        return [{"source": "databricks", "target": app, "at": x.get("create_time") or "", "state": ((x.get("status") or {}).get("state") or "").lower(),
                 "message": (x.get("status") or {}).get("message") or "", "id": x.get("deployment_id") or "", "path": x.get("source_code_path") or ""}
                for x in d if isinstance(x, dict)]
    return _cached(f"dbx:{top}:{app}:{profile}", 300, get)


def marks(cwd: str, view: dict) -> dict:
    """The slow part of History (gh and Databricks calls, cached a few minutes): PRs, Actions runs and deploys."""
    top = root(cwd)
    if not top:
        return {}
    _, remote = _run(["git", "remote", "get-url", "origin"], top, 3)
    gh = github_url(remote)
    from concurrent.futures import ThreadPoolExecutor
    apps = [a.strip() for a in str(view.get("app") or "").split(",") if a.strip()] or databricks_apps(top)
    target = databricks_target(top) or {}
    jobs = {}
    with ThreadPoolExecutor(6) as pool:
        if gh and view.get("prs", True):
            jobs["prs"] = pool.submit(pull_requests, top)
        if gh and view.get("runs", True):
            jobs["runs"] = pool.submit(action_runs, top)
        if gh and view.get("deploys", True):
            jobs["gh"] = pool.submit(github_deployments, top, gh)
        if view.get("deploys", True):
            for a in apps:
                jobs[f"dbx:{a}"] = pool.submit(databricks_deploys, top, a, target.get("profile", ""))
        res = {k: f.result() for k, f in jobs.items()}
    deploys = res.get("gh", []) + [d for k, v in res.items() if k.startswith("dbx:") for d in v]
    return {"prs": res.get("prs", []), "runs": res.get("runs", []), "deploys": deploys, "apps": apps, "github": gh,
            "host": target.get("host", "")}


# ---------- which repos a chat worked in ----------
# A chat started in Home can still do all its work in a repo (cd into it, edit, commit, push). The repo tabs follow
# what Claude actually did there: a repo counts once Claude edited a file in it or ran a git commit or push in it.
# Only reading, listing or cd-ing doesn't count, and nothing is guessed from words in the chat.
_CD = re.compile(r"""(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|(?:\\ |\S)+)""")
_GIT_C = re.compile(r"""\bgit\s+-C\s+("[^"]+"|'[^']+'|(?:\\ |\S)+)""")
_WRITE = re.compile(r"\bgit\s+(?:-[Cc]\s+\S+\s+|-\S+\s+)*(?:commit|push)\b")
_SKIP_ROOTS = ("/tmp/", "/private/tmp/", "/private/var/", "/var/folders/")
_worked: dict[str, tuple[int, dict]] = {}  # transcript path -> (bytes read, {repo: [edits, commits, last ts]})
_dir_root: dict[str, str | None] = {}


def _root_of(path: str) -> str | None:
    d = path
    while d and d != "/" and not Path(d).is_dir():
        d = str(Path(d).parent)
    if not d or d == "/":
        return None
    if d not in _dir_root:
        top = root(d)
        _dir_root[d] = None if not top or top == str(Path.home()) or (top + "/").startswith(_SKIP_ROOTS) else top
    return _dir_root[d]


def _target(raw: str, cwd: str) -> str:
    p = raw.strip("'\"").replace("\\ ", " ")
    p = str(Path(p).expanduser()) if p.startswith("~") else p
    return str((Path(cwd) / p).resolve()) if not p.startswith("/") else p


def _scan(f: Path) -> dict:
    """Count edits and commits/pushes per repo in one transcript; reads only what's new since last time."""
    key = str(f)
    try:
        size = f.stat().st_size
    except OSError:
        return {}
    import history  # here: it's only needed for the saved results
    if key not in _worked and (d := history.disk_get("repos", f.stem)) and d.get("path") == key:
        _worked[key] = (d["done"], d["counts"])
    done, counts = _worked.get(key, (0, {}))
    if size < done:
        done, counts = 0, {}
    if size == done:
        return counts
    counts = {k: list(v) for k, v in counts.items()}
    cwd = str(Path.home())

    def hit(top: str | None, i: int, ts: str) -> None:
        if top:
            c = counts.setdefault(top, [0, 0, ""])
            c[i] += 1
            c[2] = max(c[2], ts)

    with f.open("rb") as fh:
        fh.seek(done)
        for raw in fh:
            if not raw.endswith(b"\n"):
                break  # still being written: pick it up next time
            done += len(raw)
            if b'"tool_use"' not in raw:
                continue
            try:
                e = json.loads(raw)
            except ValueError:
                continue
            cwd, ts = e.get("cwd") or cwd, e.get("timestamp") or ""
            for b in (e.get("message") or {}).get("content") or []:
                if not isinstance(b, dict) or b.get("type") != "tool_use":
                    continue
                i = b.get("input") or {}
                if b.get("name") in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                    p = i.get("file_path") or i.get("notebook_path") or ""
                    if p:
                        hit(_root_of(_target(p, cwd)), 0, ts)
                elif b.get("name") == "Bash":
                    cmd = str(i.get("command") or "")
                    if not _WRITE.search(cmd):
                        continue
                    places = [_target(m.group(1), cwd) for rx in (_CD, _GIT_C) for m in rx.finditer(cmd)] or [cwd]
                    for top in {_root_of(p) for p in places}:
                        hit(top, 1, ts)
    _worked[key] = (done, counts)
    history.disk_put("repos", f.stem, {"path": key, "done": done, "counts": counts})
    return counts


def worked_in(files: list[Path], start: str) -> list[dict]:
    """Repos for a chat: the one it started in (if any), then the ones it edited or committed in, most work first."""
    total: dict[str, list] = {}
    for f in files:
        for top, (ed, cm, ts) in _scan(f).items():
            t = total.setdefault(top, [0, 0, ""])
            t[0] += ed; t[1] += cm; t[2] = max(t[2], ts)
    out = [{"top": top, "name": Path(top).name, "edits": ed, "commits": cm, "last": ts}
           for top, (ed, cm, ts) in sorted(total.items(), key=lambda x: (-(x[1][0] + x[1][1]), x[0]))]
    home = _root_of(start) if start else None
    if home:
        out = [r for r in out if r["top"] != home]
        out.insert(0, {"top": home, "name": Path(home).name, "edits": total.get(home, [0])[0],
                       "commits": total.get(home, [0, 0])[1], "last": total.get(home, ["", "", ""])[2], "started": True})
    return out


# ---------- open work: branches and pull requests ----------
def _checks(rollup: list) -> dict:
    states = [str(c.get("conclusion") or c.get("state") or c.get("status") or "").upper() for c in rollup or []]
    fail = sum(s in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT") for s in states)
    pend = sum(s in ("PENDING", "IN_PROGRESS", "QUEUED", "EXPECTED", "") for s in states)
    return {"total": len(states), "failed": fail, "pending": pend}


def open_prs(top: str, max_age: float = 120) -> list[dict]:
    """Every open PR in the repo (not just this branch's), with checks and review state."""
    def get():
        d = _gh_json(top, ["pr", "list", "--state", "open", "-L", "30", "--json",
                           "number,title,url,isDraft,headRefName,baseRefName,reviewDecision,author,statusCheckRollup,updatedAt"]) or []
        return [{"number": p["number"], "title": p["title"], "url": p["url"], "draft": bool(p.get("isDraft")),
                 "branch": p.get("headRefName") or "", "base": p.get("baseRefName") or "", "review": p.get("reviewDecision") or "",
                 "author": (p.get("author") or {}).get("login") or "", "updated": p.get("updatedAt") or "",
                 "checks": _checks(p.get("statusCheckRollup"))} for p in d]
    return _cached(f"open-prs:{top}", max_age, get)


def branches(cwd: str) -> dict:
    """Local branches against the main branch: commits not in main yet, unpushed commits, and the PR each one has."""
    top = root(cwd)
    if not top:
        return {"git": False}
    main = default_branch(top) or "main"
    base = f"origin/{main}" if _run(["git", "rev-parse", "--verify", "-q", f"origin/{main}"], top, 3)[0] == 0 else main
    _, cur = _run(["git", "rev-parse", "--abbrev-ref", "HEAD"], top, 3)
    code, out = _run(["git", "for-each-ref", "refs/heads", "--sort=-committerdate", "--format",
                      f"%(refname:short)\x1f%(upstream:short)\x1f%(upstream:track,nobracket)\x1f%(committerdate:unix)\x1f%(ahead-behind:{base})\x1f%(subject)"], top, 5)
    prs: dict[str, dict] = {}
    for p in sorted(pull_requests(top), key=lambda p: p["at"]):  # newest PR per branch wins
        prs[p["branch"]] = p
    out_b = []
    for line in out.splitlines() if code == 0 else []:
        name, up, track, when, ab, subject = (line.split("\x1f") + [""] * 6)[:6]
        if name == main:
            continue
        ahead_main = int(ab.split()[0]) if ab.split() else 0
        unpushed = int(re.search(r"ahead (\d+)", track).group(1)) if "ahead" in track else 0
        pr = prs.get(name)
        out_b.append({"name": name, "current": name == cur.strip(), "remote": bool(up) and "gone" not in track,
                      "unpushed": unpushed, "ahead_main": ahead_main, "when": int(when or 0), "subject": subject,
                      "pr": {"number": pr["number"], "state": pr["state"], "url": pr["url"]} if pr else None,
                      "merged": ahead_main == 0 or bool(pr and pr["state"] == "merged")})
    return {"git": True, "root": top, "main": main, "branches": out_b}


# ---------- keeping GitHub's side current ----------
# Branch, PR and "up to date" lines compare against the copy of GitHub's branches stored in the repo, which only
# changes on a fetch. So the panel fetches (with --prune, so branches deleted on GitHub drop out) at most every five
# minutes, or right away on ↻. A fetch only updates that stored copy: your files and branches are never touched.
_fetched: dict[str, float] = {}


def fetch(top: str, max_age: float = 300) -> bool:
    if time.time() - _fetched.get(top, 0) < max_age:
        return False
    _fetched[top] = time.time()
    return _run(["git", "fetch", "--prune", "--quiet", "origin"], top, 30)[0] == 0


_PR_NUM = re.compile(r"^Merge pull request #(\d+)|\(#(\d+)\)$")


def _pr_nums(top: str, rng: str) -> list[int]:
    _, out = _run(["git", "log", "--first-parent", "--format=%s", rng], top, 5)
    return [int(m.group(1) or m.group(2)) for m in map(_PR_NUM.search, out.splitlines()) if m]


def main_status(top: str) -> dict:
    """GitHub's main branch: its latest change, whether your copy has pulled it, and what each deploy target last got."""
    main = default_branch(top) or "main"
    ref = f"origin/{main}"
    code, head = _run(["git", "log", "-1", "--format=%H\x1f%h\x1f%s\x1f%ct", ref], top, 3)
    if code != 0 or not head.strip():
        return {}
    sha, short, subject, when = head.strip().split("\x1f")
    nums = _pr_nums(top, f"{ref}~1..{ref}") if _run(["git", "rev-parse", "-q", "--verify", f"{ref}~1"], top, 3)[0] == 0 else []
    _, behind = _run(["git", "rev-list", "--count", f"{main}..{ref}"], top, 3)
    _, remote = _run(["git", "remote", "get-url", "origin"], top, 3)
    gh = github_url(remote)
    targets = []
    newest: dict[str, dict] = {}
    for d in sorted(github_deployments(top, gh), key=lambda d: d["at"]):
        if d["source"] == "github" and d["sha"]:
            newest[d["target"]] = d
        elif d["source"] == "release" and d["state"] == "published" and d.get("tag"):
            c, tsha = _run(["git", "rev-list", "-n1", d["tag"]], top, 3)
            if c == 0 and tsha.strip():
                newest["Release"] = {**d, "sha": tsha.strip(), "target": "Release", "name": d["target"]}
    if any(d["source"] == "github" for d in newest.values()):
        newest.pop("Release", None)  # a release that triggers a deploy shows up as that deploy already
    for name, d in newest.items():
        on_main = _run(["git", "merge-base", "--is-ancestor", d["sha"], ref], top, 3)[0] == 0
        since = int(_run(["git", "rev-list", "--count", "--first-parent", f"{d['sha']}..{ref}"], top, 3)[1].strip() or 0) if on_main else None
        targets.append({"target": name, "at": d["at"], "url": d["url"], "on_main": on_main, "since": since, "label": d.get("name", ""),
                        "prs": _pr_nums(top, f"{d['sha']}..{ref}") if on_main and since else []})
    dbx = databricks_target(top) or {}
    for app in databricks_apps(top):  # app deploys ship a working copy, not a commit: only the time is known
        done = [d for d in databricks_deploys(top, app, dbx.get("profile", "")) if d["state"] in ("succeeded", "")]
        if done:
            d = max(done, key=lambda d: d["at"])
            targets.append({"target": f"{app} app", "at": d["at"], "url": f"{dbx['host'].rstrip('/')}/apps/{app}" if dbx.get("host") else "",
                            "on_main": None, "since": None, "label": "", "prs": []})
    targets.sort(key=lambda t: (0 if t["target"].upper().startswith("PROD") else 1, t["target"]))
    titles = {p["number"]: p["title"] for p in pull_requests(top)} if nums else {}
    return {"main": main, "sha": sha, "short": short, "subject": titles.get(nums[0], subject) if nums else subject, "when": int(when), "prs": nums,
            "behind": int(behind.strip() or 0), "local": _run(["git", "rev-parse", "-q", "--verify", main], top, 3)[0] == 0,
            "targets": targets[:4], "github": gh}
