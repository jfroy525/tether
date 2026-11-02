"""
The workbench's own tools, offered to Claude Code as an MCP server ("workbench"): see the screen, draw on it,
show tables of results and artifacts in the app. The app watches the stream for mark_up_screen, show_table and
show_artifact and does the drawing and rendering itself; here they're checked and acknowledged, and show_artifact
returns a picture of the page so Claude can check its own work. Minimal JSON-RPC over stdio.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import screen  # noqa: E402

import os  # noqa: E402

MARK = {"type": "object", "properties": {
    "kind": {"type": "string", "enum": sorted(screen.KINDS),
             "description": "circle/box: ring or frame round an area. highlight: highlighter over text. underline. "
                            "strike, cross, check. arrow / line: from x,y to x2,y2. number: a numbered step badge "
                            "(text = the number). label: a short tag. note: a text card (wraps to w). path: freehand "
                            "through `points`. spotlight: dims everything except the area."},
    "x": {"type": "number", "description": "left edge (or start point), in screenshot pixels"},
    "y": {"type": "number", "description": "top edge (or start point), in screenshot pixels"},
    "w": {"type": "number"}, "h": {"type": "number"},
    "x2": {"type": "number"}, "y2": {"type": "number"},
    "points": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
    "text": {"type": "string"},
    "color": {"type": "string", "description": "a colour name or hex; default red"},
    "image": {"type": "integer", "description": "which picture from the latest screenshot(s) (1 = first)"}},
    "required": ["kind"]}

SPECS = [
    {"name": "look_at_screen",
     "description": "Screenshot of what the user is looking at: by default the front window of the app they're "
                    "using (never this app). what=\"screen\" for the whole display, \"all_screens\" for every "
                    "monitor; window=<app name, title words or an id from list_windows> for a particular window.",
     "inputSchema": {"type": "object", "properties": {
         "what": {"type": "string", "enum": ["window", "screen", "all_screens"]},
         "window": {"type": "string"}}}},
    {"name": "list_windows",
     "description": "Every open window on the Mac (app, title, which screen), to pick one for look_at_screen.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "mark_up_screen",
     "description": "Draw on the user's real screen to point things out: circles, arrows, numbered steps, notes. "
                    "Coordinates are pixels in the latest screenshot (from look_at_screen, or one the user attached "
                    "or circled). Use whenever your answer is about where something is on screen. An empty list "
                    "clears them.",
     "inputSchema": {"type": "object", "properties": {"marks": {"type": "array", "items": MARK}},
                     "required": ["marks"]}},
    {"name": "show_table",
     "description": "Show tabular results (a SQL query, a comparison, a list of records) in the app as a sortable "
                    "table the user can copy or export. Use it instead of a markdown table whenever there are more "
                    "than about 5 rows or 4 columns. Then write only a one-line takeaway, not the rows again.",
     "inputSchema": {"type": "object", "properties": {
         "title": {"type": "string", "description": "a few words, e.g. \"HL7 messages by facility, last 7 days\""},
         "columns": {"type": "array", "items": {"type": "string"}},
         "rows": {"type": "array", "items": {"type": "array"}},
         "note": {"type": "string", "description": "optional: the query or source, shown under the table"}},
         "required": ["columns", "rows"]}},
    {"name": "show_artifact",
     "description": "Show a file you made on the app's Shelf beside the chat: an HTML page (dashboard, mockup, "
                    "tool, report), SVG, Markdown or code. Write the file first (where the user's instructions say, else in "
                    "the project), then call this. For HTML and SVG it returns a picture of how it renders and "
                    "any script errors: check it and fix what's broken, then call again. Pages are sealed: no network, "
                    "so put scripts, styles and data inline (images next to the file are inlined); the usual CDN links "
                    "for Mermaid, Chart.js and D3 do work. After later edits, "
                    "call it again with a short note of what changed.",
     "inputSchema": {"type": "object", "properties": {
         "path": {"type": "string", "description": "the file, absolute or relative to the working folder"},
         "title": {"type": "string", "description": "a few words, e.g. \"Weekly sales dashboard\""},
         "note": {"type": "string", "description": "what this version changed, a few words (optional on the first)"},
         "look": {"type": "boolean", "description": "return the picture (default true for HTML and SVG)"}},
         "required": ["path"]}},
    {"name": "recall",
     "description": "Look something up in this session's full saved history, including parts dropped by compaction "
                    "and any earlier session this one continues. Ask a specific question (\"which warehouse id did we "
                    "grant the app?\", \"why did we pin scramp?\"). Returns a short answer with line numbers. If it "
                    "finds nothing, try again with other words before asking the user.",
     "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}}, "required": ["question"]}},
    {"name": "session_notes",
     "description": "The running notes for this session and the sessions it continues: decisions, exact facts, open "
                    "items, gotchas and the user's preferences.",
     "inputSchema": {"type": "object", "properties": {}}},
]


def look_at_screen(args: dict) -> dict:
    ok, err, parts = screen.capture(str(args.get("what") or "window"), str(args.get("window") or ""))
    if not ok:
        return {"content": [{"type": "text", "text": err}], "isError": True}
    content = []
    for i, p in enumerate(parts, 1):
        name = f"Picture {i} of {len(parts)}: " if len(parts) > 1 else "Screenshot of "
        content.append({"type": "text", "text": f"{name}{p['label']}, {p['img_w']}×{p['img_h']} pixels.{p.get('note', '')}"})
        content.append({"type": "image", "data": base64.b64encode(Path(p["path"]).read_bytes()).decode(),
                        "mimeType": "image/jpeg"})
        Path(p["path"]).unlink(missing_ok=True)
    return {"content": content, "isError": False}


def show_artifact(args: dict) -> dict:
    import artifacts  # noqa: E401 - only loaded when asked
    p = Path(str(args.get("path") or "")).expanduser()
    p = p if p.is_absolute() else Path.cwd() / p
    if not p.is_file():
        return {"content": [{"type": "text", "text": f"No file at {p}. Write it first."}], "isError": True}
    text = f"Showing “{args.get('title') or p.name}” on the Shelf."
    if artifacts.kind(str(p)) not in ("page", "svg") or args.get("look") is False:
        return {"content": [{"type": "text", "text": text}], "isError": False}
    r = artifacts.look(str(p))
    if r.get("error"):
        return {"content": [{"type": "text", "text": f"{text} Couldn't take a picture of it: {r['error']}"}], "isError": False}
    errs = r.get("errors") or []
    text += (f" Picture below, {r['w']}×{r['h']} at the panel's width{' (cut off at the bottom; the page is longer)' if r.get('cut') else ''}. "
             + (f"Script errors: {'; '.join(errs)}" if errs else "No script errors."))
    return {"content": [{"type": "text", "text": text}, {"type": "image", "data": r["jpeg"], "mimeType": "image/jpeg"}], "isError": False}


def call(name: str, args: dict) -> tuple[bool, str]:
    if name == "list_windows":
        return True, screen.describe_windows()
    if name == "mark_up_screen":
        marks = args.get("marks") or []
        if marks and not screen.last_capture().get("parts"):
            return False, "Take a screenshot with look_at_screen first, so the marks land in the right places."
        if marks and not screen.place_marks(marks):
            return False, ("The latest screenshot is of a window that's behind others or out of sight, so nothing "
                           "can be drawn on it. Describe where things are instead.")
        return True, f"Drawing {len(marks)} mark(s) on the user's screen." if marks else "Cleared."
    if name in ("recall", "session_notes"):
        import recall, notes  # noqa: E401 - only loaded when asked
        sid = os.environ.get("ANVIL_SID", "")
        if not sid:
            return False, "No session id; recall works in sessions started from Tether."
        if name == "recall":
            # Claude often calls this before its schema is loaded and guesses the field name ("query"), so take any text
            q = str(args.get("question") or next((v for v in args.values() if isinstance(v, str) and v.strip()), "")).strip()
            return (True, recall.lookup(sid, q)) if q else (False, 'Pass the question as {"question": "..."}.')
        # the working notes, the same bounded set a fresh session gets; older ones are archived and recall searches them
        return True, notes.render_lineage([sid]) or "No notes yet. Tether writes them as the session grows; use recall meanwhile."
    if name == "show_table":
        rows = args.get("rows") or []
        return True, f"Showing {len(rows)} row(s) in the app. Don't repeat them; give the takeaway."
    return False, f"Unknown tool {name}."


def handle(msg: dict) -> dict | None:
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None
    if method == "initialize":
        result = {"protocolVersion": (msg.get("params") or {}).get("protocolVersion", "2025-06-18"),
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "workbench", "version": "1.0"}}
    elif method == "tools/list":
        result = {"tools": SPECS}
    elif method == "tools/call":
        params = msg.get("params") or {}
        try:
            if params.get("name") == "look_at_screen":
                result = look_at_screen(params.get("arguments") or {})
            elif params.get("name") == "show_artifact":
                result = show_artifact(params.get("arguments") or {})
            else:
                ok, text = call(params.get("name", ""), params.get("arguments") or {})
                result = {"content": [{"type": "text", "text": text}], "isError": not ok}
        except Exception as exc:  # noqa: BLE001 - report it to the model, don't die
            result = {"content": [{"type": "text", "text": f"Failed: {exc}"}], "isError": True}
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"No method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            reply = handle(json.loads(line))
        except ValueError:
            continue
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
