"""
The View tab's files: artifacts Claude shows with show_artifact, and anything you move there from a preview.
Every change to one of them is kept as a version in Tether's support folder (never in the project), so you can
step back and restore. HTML is shown sealed off: no network, no access to Tether, scripts run only inside it.
"""

from __future__ import annotations

import base64
import difflib
import hashlib
import json
import mimetypes
import os
import re
import subprocess
import sys
import time
from pathlib import Path

STORE = Path.home() / "Library/Application Support/Tether/artifacts"  # workbench points this at its own folder
KEEP = 40               # versions kept per file
MAX_BYTES = 5_000_000   # bigger files are shown but not versioned
HERE = Path(__file__).resolve().parent

PAGE = {".html", ".htm"}
MARKDOWN = {".md", ".markdown"}
IMAGES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".heic"}

# Sealed: inline scripts and styles run; nothing loads from or goes to the network; images only from inside the page.
CSP = ("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; "
       "img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; "
       "frame-src 'none'; base-uri 'none'")


def kind(path: str) -> str:
    ext = Path(path).suffix.lower()
    return "page" if ext in PAGE else "svg" if ext == ".svg" else "markdown" if ext in MARKDOWN else "image" if ext in IMAGES else "code"


def _dir(path: str) -> Path:
    return STORE / hashlib.sha1(str(Path(path).expanduser().resolve()).encode()).hexdigest()[:16]


def _index(path: str) -> dict:
    try:
        return json.loads((_dir(path) / "index.json").read_text())
    except (OSError, ValueError):
        return {"path": str(path), "versions": []}


def versions(path: str) -> list[dict]:
    return _index(path)["versions"]


def snapshot(path: str, note: str = "", sid: str = "", title: str = "") -> dict | None:
    """Keep the file as a new version if it changed since the last one. Returns the newest version.
    sid and title: the chat that just showed it, so the Shelf can list recent ones across chats."""
    p = Path(path).expanduser()
    try:
        data = p.read_bytes()
    except OSError:
        return None
    idx = _index(path)
    vs = idx["versions"]
    sha = hashlib.sha1(data).hexdigest()
    if sid:
        idx.update(sid=sid, title=title or idx.get("title") or p.name, shown=time.time())
    if vs and vs[-1]["sha"] == sha:
        if note and not vs[-1].get("note"):
            vs[-1]["note"] = note[:120]
        if sid or note:
            _dir(path).mkdir(parents=True, exist_ok=True)
            (_dir(path) / "index.json").write_text(json.dumps(idx, indent=1))
        return vs[-1]
    if len(data) > MAX_BYTES:
        return vs[-1] if vs else None
    d = _dir(path)
    d.mkdir(parents=True, exist_ok=True)
    n = (vs[-1]["n"] + 1) if vs else 1
    (d / f"{n}").write_bytes(data)
    vs.append({"n": n, "ts": time.time(), "sha": sha, "size": len(data), "note": note[:120]})
    for old in vs[:-KEEP]:
        (d / f"{old['n']}").unlink(missing_ok=True)
    idx["versions"] = vs[-KEEP:]
    idx["path"] = str(p)
    (d / "index.json").write_text(json.dumps(idx, indent=1))
    return vs[-1]


def recent(limit: int = 40) -> list[dict]:
    """What Claude showed lately in any chat, newest first: {path, sid, title, shown}. Files since deleted are left out."""
    out = []
    for f in STORE.glob("*/index.json") if STORE.exists() else []:
        try:
            idx = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if idx.get("sid") and Path(idx.get("path", "")).exists():
            out.append({k: idx.get(k) for k in ("path", "sid", "title", "shown")})
    return sorted(out, key=lambda x: -(x["shown"] or 0))[:limit]


def tracked(path: str) -> bool:
    return (_dir(path) / "index.json").exists()


def moved_to(path: str) -> str | None:
    """A gone file's new name: a file in the same folder that's byte for byte one of its last saved versions."""
    p = Path(path).expanduser()
    kept = [read_version(path, v["n"]) for v in versions(path)[-3:]]
    kept = {len(b): b for b in kept if b}
    try:
        files = [f for f in p.parent.iterdir() if f.is_file() and f != p][:300]
    except OSError:
        return None
    for f in files:
        try:
            if kind(str(f)) == kind(path) and f.stat().st_size in kept and f.read_bytes() == kept[f.stat().st_size]:
                return str(f)
        except OSError:
            continue
    return None


def read_version(path: str, n: int) -> bytes | None:
    try:
        return (_dir(path) / f"{int(n)}").read_bytes()
    except (OSError, ValueError):
        return None


def restore(path: str, n: int) -> dict:
    data = read_version(path, n)
    if data is None:
        return {"error": "That version is no longer kept."}
    snapshot(path)
    Path(path).expanduser().write_bytes(data)
    return snapshot(path, f"Restored v{n}") or {}


def changes(path: str, since: int) -> dict:
    """Lines that differ from version `since` (1-based, in the current file) and a unified diff."""
    old = read_version(path, since)
    try:
        new = Path(path).expanduser().read_bytes()
    except OSError:
        return {"lines": [], "diff": ""}
    if old is None or old == new:
        return {"lines": [], "diff": ""}
    a = old.decode("utf-8", "replace").split("\n")
    b = new.decode("utf-8", "replace").split("\n")
    lines: list[int] = []
    for tag, _i1, _i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag in ("replace", "insert"):
            lines.extend(range(j1 + 1, j2 + 1))
    diff = "\n".join(difflib.unified_diff(a, b, f"v{since}", "now", n=2, lineterm=""))
    return {"lines": lines[:5000], "diff": diff[:400_000]}


def _inline_images(html: str, base: Path) -> str:
    """Pictures next to the page (src="chart.png") become data: URLs, since a sealed page can't load files."""
    def sub(m: re.Match) -> str:
        src = m.group(2)
        if re.match(r"^(data:|blob:|https?:|//|#)", src):
            return m.group(0)
        f = (base / src.split("?")[0].split("#")[0]).resolve()
        try:
            if f.is_file() and f.stat().st_size <= 8_000_000:
                mt = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
                return f'{m.group(1)}data:{mt};base64,{base64.b64encode(f.read_bytes()).decode()}{m.group(3)}'
        except OSError:
            pass
        return m.group(0)
    return re.sub(r'(<img\b[^>]*?\bsrc=["\'])([^"\']+)(["\'])', sub, html, flags=re.I)


# Charts and diagrams: a sealed page can't load Mermaid, Chart.js or D3 from the internet, so the usual CDN links are
# swapped for Tether's own copies (ui/lib). Claude writes pages the normal way and they still work outside Tether.
LIBS = {"mermaid": ("mermaid.min.js", "window.mermaid"),
        "chartjs": ("chart.umd.min.js", "Object.assign({default: window.Chart, Chart: window.Chart}, window.Chart)"),
        "d3": ("d3.min.js", "window.d3")}
LIB_DIR = HERE / "ui" / "lib"


def _lib_of(url: str) -> str | None:
    u = url.lower().split("?")[0]
    if not re.match(r"^(https?:)?//", u):
        return None
    if re.search(r"[/@]mermaid(@|/|\.|$)", u):
        return "mermaid"
    if re.search(r"chart\.js|chart\.umd|chartjs", u) and "adapter" not in u and "plugin" not in u:
        return "chartjs"
    if re.search(r"d3js\.org/d3(\.v\d+)?(\.min)?\.js|/d3@[\d.]+(/|$)|/npm/d3(/|$)|/d3/[\d.]+/d3(\.min)?\.js|/d3(\.min)?\.js$", u):
        return "d3"
    return None


def lib_mark(name: str) -> str:
    return f'<script data-tether-lib="{name}"></script>'


def lib_source(name: str) -> str:
    try:
        return (LIB_DIR / LIBS[name][0]).read_text(encoding="utf-8")
    except (KeyError, OSError):
        return ""


def swap_libs(html: str) -> tuple[str, list[str]]:
    """CDN script tags and module imports of a bundled library become a marker, lib_mark(name), that the caller fills
    with the library. Returns the page and the libraries it needs, in order."""
    used: list[str] = []

    def need(n: str) -> str:
        if n in used:
            return ""
        used.append(n)
        return lib_mark(n)

    def tag(m: re.Match) -> str:
        n = _lib_of(m.group(2))
        return need(n) if n else m.group(0)
    html = re.sub(r'<script\b([^>]*?)\bsrc=["\']([^"\']+)["\'][^>]*>\s*</script>', tag, html, flags=re.I)

    def module(m: re.Match) -> str:  # import mermaid from "https://cdn…/mermaid.esm.min.mjs" → the global it sets
        open_, body = m.group(1), m.group(2)
        marks = []

        def imp(i: re.Match) -> str:
            n = _lib_of(i.group(2))
            if not n:
                return i.group(0)
            marks.append(need(n))
            what, glob = i.group(1).strip(), LIBS[n][1]
            out = []
            ns = re.search(r"\*\s+as\s+(\w+)", what)
            named = re.search(r"\{([^}]*)\}", what)
            default = re.match(r"^([\w$]+)", what)
            if default:
                out.append(f"const {default.group(1)} = ({glob}).default || ({glob});")
            if ns:
                out.append(f"const {ns.group(1)} = {glob};")
            if named:
                parts = [re.sub(r"\s+as\s+", ": ", x.strip()) for x in named.group(1).split(",") if x.strip()]
                out.append(f"const {{ {', '.join(parts)} }} = {glob};")
            return " ".join(out)
        body = re.sub(r'import\s+([^;"\']*?)\s+from\s*["\']([^"\']+)["\']\s*;?', imp, body)
        body = re.sub(r'import\s*["\']([^"\']+)["\']\s*;?', lambda i: (marks.append(need(_lib_of(i.group(1)))) or "") if _lib_of(i.group(1)) else i.group(0), body)
        return "".join(marks) + open_ + body + "</script>"
    html = re.sub(r'(<script\b[^>]*\btype=["\']module["\'][^>]*>)(.*?)</script>', module, html, flags=re.I | re.S)
    return html, used


def fill_libs(html: str) -> str:
    for n in LIBS:
        mark = lib_mark(n)
        if mark in html:
            html = html.replace(mark, "<script>" + lib_source(n) + "</script>", 1)
    return html


ERRORS_JS = ("<script>window.__tetherErrors=[];addEventListener('error',e=>__tetherErrors.push(String(e.message||e)"
             "+(e.lineno?' (line '+e.lineno+')':'')));</script>")


def sealed_html(path: str, data: bytes | None = None, errors: bool = False, libs: bool = True) -> str:
    """libs=False leaves the library markers for the caller to fill (the Shelf fills them from its own copy, so a
    5 MB library doesn't cross into the window on every reload)."""
    p = Path(path).expanduser()
    raw = (data if data is not None else p.read_bytes()).decode("utf-8", "replace")
    if kind(path) == "svg":
        raw = (f'<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh">'
               f'<img style="max-width:100%" src="data:image/svg+xml;base64,{base64.b64encode(raw.encode()).decode()}"></body></html>')
    head = f'<meta http-equiv="Content-Security-Policy" content="{CSP}">'
    body, _ = swap_libs(_inline_images(raw, p.parent))
    if libs:
        body = fill_libs(body)
    m = re.match(r"\s*<!doctype[^>]*>", body, re.I)  # keep the doctype first, or the page drops into quirks mode
    return (m.group(0) if m else "") + head + (ERRORS_JS if errors else "") + body[m.end() if m else 0:]


def pins_js(pins: list[dict], color: str = "#0B6E86") -> str:
    """Numbered pins drawn on the page where you left notes (x, y in page pixels), for the picture Claude gets."""
    return ("<script>addEventListener('load',()=>{const L=document.createElement('div');"
            "L.style.cssText='position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';"
            f"for(const p of {json.dumps([{'n': int(p['n']), 'x': float(p['x']), 'y': float(p['y'])} for p in pins])})"
            "{const d=document.createElement('div');d.textContent=p.n;d.style.cssText='position:absolute;left:'+(p.x-11)+'px;top:'+(p.y-11)+'px;"
            f"width:22px;height:22px;border-radius:50%;background:{json.dumps(color)[1:-1]};color:#fff;font:600 12px/22px -apple-system,Helvetica,sans-serif;"
            "text-align:center;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.35)';L.appendChild(d)}document.documentElement.appendChild(L)})</script>")


def look(path: str, width: int = 600, view: dict | None = None, dark: bool | None = None) -> dict:
    """A picture of the page as the View tab draws it (same width, same light or dark), plus any script errors, for
    Claude to check its own work. Rendered off screen by WebKit (artifact_snap.py) in its own process.
    view: {"vh", "pins": [{n, x, y}], "color"} draws your note pins and shows just the part of the page around them,
    in a window as tall as the Shelf's, so the page lays out the way you saw it."""
    out = Path("/tmp") / f"tether-artifact-{hashlib.sha1(str(path).encode()).hexdigest()[:10]}.jpg"
    src = out.with_suffix(".html")
    html = sealed_html(path, errors=True)
    opts = ""
    if view and view.get("pins"):
        html += pins_js(view["pins"], view.get("color") or "#0B6E86")
        ys = [float(p["y"]) for p in view["pins"]]
        vh = max(300, int(view.get("vh") or 700))
        span = max(ys) - min(ys)
        vh = vh if span < vh - 80 else min(2400, int(span) + 160)
        opts = json.dumps({"vh": vh, "top": max(0, int((min(ys) + max(ys)) / 2 - vh / 2))})
    src.write_text(html)
    if dark is None:
        try:
            dark = bool(json.loads(Path(os.environ.get("TETHER_LOOK", "")).read_text()).get("dark"))
        except (OSError, ValueError):
            dark = False
    try:
        r = subprocess.run([sys.executable, str(HERE / "artifact_snap.py"), str(src), str(out), str(width), "dark" if dark else "light"] + ([opts] if opts else []),
                           capture_output=True, text=True, timeout=30)
    except subprocess.TimeoutExpired:
        return {"error": "Rendering took too long."}
    finally:
        src.unlink(missing_ok=True)
    try:
        info = json.loads(r.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"error": (r.stderr or "Couldn't render it.").strip()[-400:]}
    if not out.exists():
        return {"error": info.get("error") or "Couldn't render it."}
    data = out.read_bytes()
    out.unlink(missing_ok=True)
    return {**info, "jpeg": base64.b64encode(data).decode()}
