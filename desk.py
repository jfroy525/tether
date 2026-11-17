"""The Desk: Tether's own small editors, in the side panel.

  Slate   text and code (any plain-text file)
  Ledger  spreadsheets (.xlsx, .csv)
  Folio   documents (.docx)
  Tack    sticky notes

Each editor is one page under ui/desk/, shown in a sealed frame (no network, no reach into Tether). It asks for
files through the window, which calls the methods here; nothing is read or written except what you picked in an
Open or Save box, what Claude was asked to open, and the Desk's own drafts.

Claude reaches the editors with the `desk` tool (wb_mcp.py): the tool leaves a request file in Support/desk/req,
poll() hands it to the window, the editor answers, and reply() leaves the answer in Support/desk/res.
"""
from __future__ import annotations

import base64
import json
import os
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
    def _start_dir(self) -> str:
        try:
            d = json.loads((self.dir / "state.json").read_text()).get("last_dir") or ""
        except (OSError, ValueError):
            d = ""
        if d and Path(d).is_dir():
            return d
        docs = Path.home() / "Documents"
        return str(docs if docs.is_dir() else Path.home())

    def _remember(self, path: str) -> None:
        self.granted.add(path)
        try:
            (self.dir / "state.json").write_text(json.dumps({"last_dir": str(Path(path).parent)}))
        except OSError:
            pass

    def grant(self, path: str) -> str:
        p = str(Path(path).expanduser().resolve())
        self._remember(p)
        return p

    def read(self, app: str, path: str) -> dict:
        """The file in the form its editor takes: text, base64 (workbooks) or html (a .docx)."""
        p = Path(path)
        if str(p) not in self.granted:
            return {"error": "Open the file from the editor's Open box first."}
        try:
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
                    raw = ('<!doctype html><html><head><meta charset="utf-8"><title>' + p.stem.replace("<", "") + "</title></head><body>"
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
                        r["path"] = self.grant(r["path"])
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
