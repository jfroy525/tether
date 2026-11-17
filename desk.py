"""The Desk: Tether's own small editors, in the side panel.

  Slate   text and code (any plain-text file)
  Ledger  spreadsheets (.xlsx, .csv)
  Folio   documents (.docx)
  Tack    sticky notes

Each editor is one page under ui/desk/, shown in a sealed frame (no network, no reach into Tether). It asks for
files through the window, which calls the methods here; nothing is read or written except what you picked in an
Open or Save box, what sits in a folder you picked there (each editor's Files list), what Claude was asked to
open, and the Desk's own drafts.

Claude reaches the editors with the `desk` tool (wb_mcp.py): the tool leaves a request file in Support/desk/req,
poll() hands it to the window, the editor answers, and reply() leaves the answer in Support/desk/res.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import threading
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
APPS = {
    "slate": {"name": "Slate", "libs": ["codemirror"], "ext": ".txt",
              "types": ("Text and code (*.txt;*.md;*.py;*.js;*.ts;*.json;*.html;*.css;*.sql;*.sh;*.yaml;*.yml;*.xml;*.csv;*.log;*.toml;*.ini;*.c;*.h;*.cpp;*.java;*.go;*.rs;*.rb;*.php)", "All files (*.*)")},
    "ledger": {"name": "Ledger", "libs": ["jsuites", "jspreadsheet", "xlsx"], "ext": ".xlsx",
               "types": ("Spreadsheets (*.xlsx;*.xlsm;*.xls;*.csv;*.tsv;*.ods)", "All files (*.*)")},
    "folio": {"name": "Folio", "libs": [], "ext": ".docx",
              "types": ("Documents (*.docx;*.txt;*.md;*.html;*.htm)", "All files (*.*)")},
    "tack": {"name": "Tack", "libs": [], "ext": ".json", "types": ()},
}
LIBS = {  # name -> (scripts, styles) under ui/lib/desk
    "codemirror": (["codemirror.js"], ["codemirror.css"]),
    "jsuites": (["jsuites.js"], ["jsuites.css"]),
    "jspreadsheet": (["jspreadsheet.js"], ["jspreadsheet.css"]),
    "xlsx": (["xlsx.full.min.js"], []),
}
BINARY = {".xlsx", ".xlsm", ".xls", ".ods"}
MAX_TEXT = 8_000_000
MAX_BIN = 40_000_000
CSP = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; "
       "img-src data: blob:; font-src data:")


class Desk:
    def __init__(self, support: Path, emit):
        self.dir = support / "desk"
        self.req, self.res, self.drafts = self.dir / "req", self.dir / "res", self.dir / "drafts"
        for d in (self.req, self.res, self.drafts):
            d.mkdir(parents=True, exist_ok=True)
        self.emit = emit
        self.granted: set[str] = set()   # files you picked, or Claude was asked to open
        st = self._state()
        self.roots: list[str] = [d for d in st.get("roots") or [] if isinstance(d, str) and Path(d).is_dir()]  # folders you picked a file in
        self.recent: dict = {a: [p for p in (st.get("recent") or {}).get(a) or [] if isinstance(p, str)] for a in APPS}
        self._pages: dict[str, str] = {}
        self._seen: set[str] = set()
        for f in list(self.req.glob("*.json")) + list(self.res.glob("*.json")):  # left over from before a restart
            f.unlink(missing_ok=True)
        threading.Thread(target=self._poll, daemon=True).start()

    # ----- the editor pages
    def page(self, app: str) -> dict:
        if app not in APPS:
            return {"error": "No such editor."}
        src = HERE / "ui" / "desk"
        try:
            stamp = max(f.stat().st_mtime for f in src.iterdir() if f.is_file())
            key = f"{app}:{stamp}"
            if key not in self._pages:
                lib = HERE / "ui" / "lib" / "desk"
                css = "".join((lib / c).read_text() for n in APPS[app]["libs"] for c in LIBS[n][1])
                js = "".join(f"<script>{(lib / j).read_text().replace('</script', '<\\/script')}</script>" for n in APPS[app]["libs"] for j in LIBS[n][0])
                self._pages = {key: (
                    f'<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{CSP}">'
                    f"<style>{css}{(src / 'base.css').read_text()}</style></head><body data-app=\"{app}\">"
                    f"{js}<script>{(src / 'base.js').read_text()}</script>{(src / (app + '.html')).read_text()}</body></html>")}
            return {"html": self._pages[key], "name": APPS[app]["name"]}
        except OSError as exc:
            return {"error": f"Couldn't load {APPS[app]['name']}: {exc}"}

    # ----- files
    def _state(self) -> dict:
        try:
            d = json.loads((self.dir / "state.json").read_text())
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _keep(self, **changes) -> None:
        try:
            (self.dir / "state.json").write_text(json.dumps({**self._state(), "roots": self.roots, "recent": self.recent, **changes}))
        except OSError:
            pass

    def _start_dir(self) -> str:
        d = self._state().get("last_dir") or ""
        if d and Path(d).is_dir():
            return d
        docs = Path.home() / "Documents"
        return str(docs if docs.is_dir() else Path.home())

    def _recent(self, app: str, path: str, drop: bool = False) -> None:
        if app in self.recent:
            self.recent[app] = ([] if drop else [path]) + [p for p in self.recent[app] if p != path][:11]

    def grant(self, path: str, app: str = "", picked: bool = False) -> str:
        """Let the editors read and write this file. `picked` (you chose it in an Open or Save box) also lets the
        Files list show the folder it is in; a file Claude opened does not."""
        p = str(Path(path).expanduser().resolve())
        self.granted.add(p)
        self._recent(app, p)
        if picked:
            self.add_root(str(Path(p).parent), keep=False)
        self._keep(last_dir=str(Path(p).parent))
        return p

    def add_root(self, folder: str, keep: bool = True) -> str:
        d = str(Path(folder).expanduser().resolve())
        if not any(d == r or d.startswith(r.rstrip("/") + "/") for r in self.roots):
            self.roots = [r for r in self.roots if not r.startswith(d.rstrip("/") + "/")] + [d]
        if keep:
            self._keep(last_dir=d)
        return d

    def _in_root(self, path: str) -> bool:
        return any(path == r or path.startswith(r.rstrip("/") + "/") for r in self.roots)

    def _mine(self, path: str) -> bool:
        return path in self.granted or self._in_root(path)

    # ----- the Files list in each editor: recent files, and the folders you've picked files in
    def files(self, app: str, folder: str = "") -> dict:
        exts = {"." + e.lower() for e in re.findall(r"\*\.(\w+)", (APPS.get(app, {}).get("types") or ("",))[0])}
        recent = [{"path": p, "name": Path(p).name, "where": Path(p).parent.name} for p in self.recent.get(app, []) if Path(p).is_file()][:8]
        d = str(Path(folder).expanduser().resolve()) if folder else ""
        if not d or not self._in_root(d) or not Path(d).is_dir():
            last = self._state().get("last_dir") or ""
            d = last if last and self._in_root(last) and Path(last).is_dir() else next((r for r in reversed(self.roots) if Path(r).is_dir()), "")
        out = {"dir": d, "name": Path(d).name if d else "", "up": "", "folders": [], "files": [], "recent": recent,
               "roots": [{"path": r, "name": Path(r).name} for r in self.roots if Path(r).is_dir()]}
        if not d:
            return out
        up = str(Path(d).parent)
        out["up"] = up if self._in_root(up) else ""
        try:
            for e in sorted(os.scandir(d), key=lambda e: e.name.lower()):
                if e.name.startswith((".", "~$")) or e.name.endswith(".tmp"):
                    continue
                if e.is_dir():
                    out["folders"].append({"path": e.path, "name": e.name})
                elif e.is_file() and Path(e.name).suffix.lower() in exts and len(out["files"]) < 500:
                    st = e.stat()
                    out["files"].append({"path": e.path, "name": e.name, "size": st.st_size, "mtime": st.st_mtime})
        except OSError as exc:
            out["error"] = f"Couldn't list {Path(d).name}: {exc.strerror or exc}"
        return out

    def _moved(self, old: str, new: str) -> dict:
        self.granted.discard(old)
        self.granted.add(new)
        for a in self.recent:
            self.recent[a] = [new if p == old else p for p in self.recent[a]]
        self._keep()
        p = Path(new)
        return {"path": new, "name": p.name, "mtime": p.stat().st_mtime, "was": old}

    def rename(self, path: str, name: str) -> dict:
        p, name = Path(path), str(name or "").strip()
        if not self._mine(str(p)) or not p.is_file():
            return {"error": "That file isn't one the Desk can change."}
        if not name or "/" in name or ":" in name or name.startswith("."):
            return {"error": "A name can't be empty, start with a dot, or contain / or :."}
        if not Path(name).suffix:
            name += p.suffix
        to = p.with_name(name)
        try:
            if to.exists() and not (to.name.lower() == p.name.lower() and to.samefile(p)):
                return {"error": f"{name} already exists in this folder."}
            p.rename(to)
            return self._moved(str(p), str(to))
        except OSError as exc:
            return {"error": f"Couldn't rename {p.name}: {exc.strerror or exc}"}

    def duplicate(self, path: str) -> dict:
        p = Path(path)
        if not self._mine(str(p)) or not p.is_file():
            return {"error": "That file isn't one the Desk can copy."}
        try:
            for n in range(1, 200):
                to = p.with_name(f"{p.stem} copy{'' if n == 1 else ' ' + str(n)}{p.suffix}")
                if not to.exists():
                    shutil.copy2(p, to)
                    self.granted.add(str(to))
                    return {"path": str(to), "name": to.name, "mtime": to.stat().st_mtime}
            return {"error": "Too many copies of this file already."}
        except OSError as exc:
            return {"error": f"Couldn't copy {p.name}: {exc.strerror or exc}"}

    def move(self, path: str, folder: str) -> dict:
        p, d = Path(path), Path(folder)
        if not self._mine(str(p)) or not p.is_file():
            return {"error": "That file isn't one the Desk can move."}
        to = d / p.name
        try:
            if to.exists():
                return {"error": f"{p.name} already exists in {d.name}."}
            shutil.move(str(p), str(to))
            self.add_root(str(d), keep=False)
            return self._moved(str(p), str(to))
        except OSError as exc:
            return {"error": f"Couldn't move {p.name}: {exc.strerror or exc}"}

    def trash(self, path: str) -> dict:
        """To the Mac's Trash, so it can be put back from there."""
        p = Path(path)
        if not self._mine(str(p)) or not p.is_file():
            return {"error": "That file isn't one the Desk can delete."}
        try:
            done = False
            try:
                from Foundation import NSURL, NSFileManager
                done = bool(NSFileManager.defaultManager().trashItemAtURL_resultingItemURL_error_(NSURL.fileURLWithPath_(str(p)), None, None)[0])
            except Exception:
                done = False
            if not done:
                bin_ = Path.home() / ".Trash"
                to = bin_ / p.name
                if to.exists():
                    to = bin_ / f"{p.stem} {time.strftime('%H.%M.%S')}{p.suffix}"
                shutil.move(str(p), str(to))
            self.granted.discard(str(p))
            for a in self.recent:
                self._recent(a, str(p), drop=True)
            self._keep()
            return {"ok": True, "was": str(p), "name": p.name}
        except OSError as exc:
            return {"error": f"Couldn't move {p.name} to the Trash: {exc.strerror or exc}"}

    def read(self, app: str, path: str) -> dict:
        """The file in the form its editor takes: text, base64 (workbooks) or html (a .docx)."""
        p = Path(path)
        if not self._mine(str(p)):
            return {"error": "Open the file from the editor's Open box first."}
        try:
            self.granted.add(str(p))
            self._recent(app, str(p))
            self._keep()
            st = p.stat()
            ext = p.suffix.lower()
            base = {"path": str(p), "name": p.name, "mtime": st.st_mtime}
            if app == "folio" and ext == ".docx":
                import desk_docx
                return {**base, "html": desk_docx.to_html(str(p))}
            if app == "ledger" and ext in BINARY:
                if st.st_size > MAX_BIN:
                    return {"error": f"{p.name} is too large to open here ({st.st_size // 1_000_000} MB)."}
                return {**base, "b64": base64.b64encode(p.read_bytes()).decode()}
            if st.st_size > MAX_TEXT:
                return {"error": f"{p.name} is too large to open here ({st.st_size // 1_000_000} MB)."}
            raw = p.read_bytes()
            if b"\0" in raw[:8000]:
                return {"error": f"{p.name} isn't a text file."}
            return {**base, "text": raw.decode("utf-8", "replace")}
        except (zipfile.BadZipFile, KeyError):
            return {"error": f"{p.name} isn't a Word document Folio can read."}
        except OSError as exc:
            return {"error": f"Couldn't open {p.name}: {exc.strerror or exc}"}
        except Exception as exc:  # a damaged document
            return {"error": f"Couldn't read {p.name}: {exc}"}

    def write(self, app: str, path: str, data: dict) -> dict:
        p = Path(path)
        if str(p) not in self.granted:
            return {"error": "Save it with Save as first."}
        try:
            ext = p.suffix.lower()
            if app == "folio" and ext == ".docx":
                import desk_docx
                desk_docx.from_html(str(data.get("html") or ""), str(p))
            else:
                if app == "folio" and ext in (".html", ".htm"):
                    raw = ('<!doctype html><html><head><meta charset="utf-8"><title>' + p.stem.replace("<", "") + "</title><style>p,div,h1,h2,h3,h4,blockquote,li,td,th{position:relative}img{max-width:100%;height:auto}img.free{position:absolute;max-width:none}</style></head><body>"
                           + str(data.get("html") or "") + "</body></html>").encode("utf-8")
                else:
                    raw = base64.b64decode(data["b64"]) if data.get("b64") is not None else str(data.get("text") or "").encode("utf-8")
                tmp = p.with_name(p.name + ".tmp")
                tmp.write_bytes(raw)
                tmp.replace(p)
            return {"path": str(p), "name": p.name, "mtime": p.stat().st_mtime}
        except OSError as exc:
            return {"error": f"Couldn't save {p.name}: {exc.strerror or exc}"}
        except Exception as exc:
            return {"error": f"Couldn't save {p.name}: {exc}"}

    def stat(self, path: str) -> dict:
        try:
            return {"mtime": Path(path).stat().st_mtime} if path in self.granted else {"mtime": 0}
        except OSError:
            return {"mtime": 0, "missing": True}

    # ----- drafts: what was open, saved or not, so a restart of Tether loses nothing
    def draft_load(self, app: str) -> dict:
        try:
            d = json.loads((self.drafts / f"{app}.json").read_text())
        except (OSError, ValueError):
            return {}
        for path in d.get("paths") or []:
            if isinstance(path, str) and path and Path(path).is_file():
                self.granted.add(path)
        return d

    def draft_save(self, app: str, draft: dict) -> dict:
        if app not in APPS:
            return {"ok": False}
        f = self.drafts / f"{app}.json"
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(draft))
        tmp.replace(f)
        return {"ok": True}

    # ----- Claude's requests
    def _poll(self) -> None:
        while True:
            time.sleep(0.25)
            try:
                for f in self.req.iterdir():
                    if f.suffix != ".json" or f.name in self._seen:
                        continue
                    self._seen.add(f.name)
                    try:
                        r = json.loads(f.read_text())
                    except (OSError, ValueError):
                        continue
                    if r.get("action") == "open" and r.get("path"):
                        r["path"] = self.grant(r["path"], str(r.get("app") or "").lower())
                    self.emit({"type": "desk_req", "id": f.stem, "sid": r.get("sid") or "", "action": r.get("action") or "",
                               "app": r.get("app") or "", "args": {k: v for k, v in r.items() if k not in ("sid", "action", "app")}})
            except OSError:
                pass

    def reply(self, rid: str, result) -> dict:
        if not rid or "/" in rid or ".." in rid:
            return {"ok": False}
        tmp = self.res / f"{rid}.tmp"
        tmp.write_text(json.dumps(result))
        tmp.replace(self.res / f"{rid}.json")
        (self.req / f"{rid}.json").unlink(missing_ok=True)
        self._seen.discard(f"{rid}.json")
        return {"ok": True}


# ----- the tool's side (runs inside wb_mcp.py, a separate process per chat)

def ask(support: Path, sid: str, args: dict, wait: float = 30.0) -> tuple[bool, str]:
    d = support / "desk"
    if not (d / "req").is_dir():
        return False, "The Desk isn't available: this Tether is older than the tool, or isn't running. Ask the user to restart Tether."
    rid = f"{int(time.time() * 1000)}-{os.getpid()}"
    req, res = d / "req" / f"{rid}.json", d / "res" / f"{rid}.json"
    tmp = req.with_suffix(".tmp")
    tmp.write_text(json.dumps({**args, "sid": sid}))
    tmp.replace(req)
    end = time.time() + wait
    while time.time() < end:
        if res.exists():
            try:
                r = json.loads(res.read_text())
            except (OSError, ValueError):
                time.sleep(0.05)
                continue
            res.unlink(missing_ok=True)
            if isinstance(r, dict) and r.get("error"):
                return False, str(r["error"])
            return True, r if isinstance(r, str) else json.dumps(r, ensure_ascii=False)
        time.sleep(0.1)
    req.unlink(missing_ok=True)
    return False, "The Desk didn't answer. Tether's window may be closed, or it needs a restart to load the Desk."
