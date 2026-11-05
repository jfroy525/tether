"""
"Look at my screen": screenshots of the window the user is working in (never this app's own
windows), any other open window, or every screen, sized for Claude, plus where that picture sits on the screen so live markup
(markup.html) can draw circles and arrows in the right places. Needs the Mac's Screen Recording
permission; nothing is kept after the request (the picture goes in a temp folder).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

LAST = next((p for p in (Path.home() / "Library/Application Support" / n for n in ("Tether", "Anvil")) if p.is_dir()),
            Path.home() / "Library/Application Support/Tether") / "last-screen.json"
MAX_SIDE = 1568  # Claude sees images up to about this size without shrinking them itself
SKIP_OWNERS = {"Tether", "Anvil", "JordCode", "Claude Workbench", "Forge Assistant", "Window Server", "Dock", "Control Center", "Notification Center", "Spotlight"}
PERMISSION_HELP = ("Tether needs Screen Recording permission to see your screen: System Settings › Privacy & "
                   "Security › Screen & System Audio Recording, turn on Tether, then reopen the app.")


def allowed(ask: bool = False) -> bool:
    import Quartz
    if Quartz.CGPreflightScreenCaptureAccess():
        return True
    if ask:
        Quartz.CGRequestScreenCaptureAccess()  # shows the system prompt (once) and lists the app in Settings
    return False


def _app_pids() -> set[int]:
    pids = {os.getpid(), os.getppid()}
    if os.environ.get("FORGE_APP_PID", "").isdigit():
        pids.add(int(os.environ["FORGE_APP_PID"]))
    return pids


def front_window() -> dict | None:
    """The frontmost ordinary window that isn't ours: what the user is looking at."""
    import Quartz
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    ours = _app_pids()
    for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []:
        b = w.get("kCGWindowBounds") or {}
        if (w.get("kCGWindowLayer", 0) != 0 or w.get("kCGWindowOwnerPID") in ours
                or w.get("kCGWindowOwnerName") in SKIP_OWNERS or float(w.get("kCGWindowAlpha", 1)) == 0
                or b.get("Width", 0) < 160 or b.get("Height", 0) < 100):
            continue
        return {"id": int(w["kCGWindowNumber"]), "app": str(w.get("kCGWindowOwnerName") or ""),
                "title": str(w.get("kCGWindowName") or ""), "pid": int(w.get("kCGWindowOwnerPID") or 0),
                "x": float(b["X"]), "y": float(b["Y"]), "w": float(b["Width"]), "h": float(b["Height"])}
    return None


def displays() -> list[dict]:
    """Every display in global points (top-left origin, like window bounds), numbered for people: the main
    one is screen 1, then left to right. `where` says where it sits relative to the main one."""
    import Quartz
    err, ids, _ = Quartz.CGGetActiveDisplayList(16, None, None)
    out = []
    for d in ids or []:
        r = Quartz.CGDisplayBounds(d)
        out.append({"id": int(d), "x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height,
                    "main": bool(Quartz.CGDisplayIsMain(d))})
    out.sort(key=lambda d: (not d["main"], d["x"], d["y"]))
    for i, d in enumerate(out, 1):
        d["n"] = i
        if d["main"]:
            d["where"] = "main"
        elif d["x"] >= out[0]["x"] + out[0]["w"]:
            d["where"] = "right of the main screen"
        elif d["x"] + d["w"] <= out[0]["x"]:
            d["where"] = "left of the main screen"
        else:
            d["where"] = "above the main screen" if d["y"] < out[0]["y"] else "below the main screen"
    return out


def display_for(x: float, y: float) -> dict:
    ds = displays()
    for d in ds:
        if d["x"] <= x < d["x"] + d["w"] and d["y"] <= y < d["y"] + d["h"]:
            return d
    return ds[0]


NOT_WINDOWS = SKIP_OWNERS | {"AutoFill", "loginwindow", "UserNotificationCenter", "jamfRemoteAssistConnectorUI",
                              "WindowManager", "SystemUIServer", "TextInputMenuAgent", "CursorUIViewService", "universalAccessAuthWarn"}


def list_windows() -> list[dict]:
    """Every open window with a title, front to back: on screen ones first, then the ones that aren't
    (minimized, or on another desktop). Titles need Screen Recording permission."""
    import Quartz
    no_desktop = Quartz.kCGWindowListExcludeDesktopElements
    # The full list isn't front to back; the on-screen one is, so take the order from that.
    shown = [w for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly | no_desktop,
                                                          Quartz.kCGNullWindowID) or [] if w.get("kCGWindowLayer", 0) == 0]
    z = {int(w["kCGWindowNumber"]): i for i, w in enumerate(shown)}
    opts = Quartz.kCGWindowListOptionAll | no_desktop
    ours, out = _app_pids(), []

    def rect(w):
        b = w.get("kCGWindowBounds") or {}
        return float(b.get("X", 0)), float(b.get("Y", 0)), float(b.get("Width", 0)), float(b.get("Height", 0))

    def hidden_part(i, r):  # how much of the window at z-position i is under windows in front of it (not ours)
        x, y, ww, hh = r
        over = 0.0
        for f in shown[:i]:
            if f.get("kCGWindowOwnerPID") in ours or f.get("kCGWindowOwnerName") in NOT_WINDOWS:
                continue
            fx, fy, fw, fh = rect(f)
            over += max(0.0, min(x + ww, fx + fw) - max(x, fx)) * max(0.0, min(y + hh, fy + fh) - max(y, fy))
        return min(1.0, over / max(1.0, ww * hh))
    for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []:
        b = w.get("kCGWindowBounds") or {}
        title = str(w.get("kCGWindowName") or "").strip()
        if (w.get("kCGWindowLayer", 0) != 0 or w.get("kCGWindowOwnerPID") in ours or not title
                or "do not localize" in title or w.get("kCGWindowOwnerName") in NOT_WINDOWS
                or b.get("Width", 0) < 160 or b.get("Height", 0) < 100):
            continue
        x, y, ww, hh = float(b["X"]), float(b["Y"]), float(b["Width"]), float(b["Height"])
        wid = int(w["kCGWindowNumber"])
        visible = wid in z
        out.append({"id": wid, "app": str(w.get("kCGWindowOwnerName") or ""), "title": title,
                    "x": x, "y": y, "w": ww, "h": hh, "visible": visible, "order": z.get(wid, 9999),
                    "covered": visible and hidden_part(z[wid], (x, y, ww, hh)) > 0.2,
                    "screen": display_for(x + ww / 2, y + hh / 2)["n"]})
    out.sort(key=lambda w: w["order"])
    return out


def window_stack() -> list[dict]:
    """Windows on screen now, front to back, for Mark up a window: the pointer lights up the first one it's over.
    Tether's own windows are kept as `ours`, so pointing at Tether lights nothing up instead of what's behind it."""
    import Quartz
    ours, out = _app_pids(), []
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    for w in Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []:
        b = w.get("kCGWindowBounds") or {}
        owner = str(w.get("kCGWindowOwnerName") or "")
        if w.get("kCGWindowLayer", 0) != 0 or float(w.get("kCGWindowAlpha", 1)) == 0:
            continue
        mine = w.get("kCGWindowOwnerPID") in ours
        if not mine and (owner in NOT_WINDOWS or b.get("Width", 0) < 160 or b.get("Height", 0) < 100):
            continue
        out.append({"id": int(w["kCGWindowNumber"]), "app": owner, "title": str(w.get("kCGWindowName") or "").strip(),
                    "pid": int(w.get("kCGWindowOwnerPID") or 0), "ours": mine,
                    "x": float(b["X"]), "y": float(b["Y"]), "w": float(b["Width"]), "h": float(b["Height"])})
    return out


def capture_picked(win: dict) -> tuple[bool, str, list[dict]]:
    """Mark up a window: a picture of just the window the user clicked, kept as the marks' reference."""
    if not allowed():
        return False, PERMISSION_HELP, []
    folder = Path(tempfile.gettempdir()) / "workbench-screen"
    folder.mkdir(exist_ok=True)
    for old in folder.glob("*"):
        old.unlink(missing_ok=True)
    got = _shot(["screencapture", "-x", "-o", f"-l{win['id']}"], folder)
    if not got:
        return False, "Couldn't take a picture of that window.", []
    now = next((w for w in list_windows() if w["id"] == win["id"]), None)  # it may have moved or come forward
    w = now or win
    covered = bool(now and now.get("covered"))
    part = {"kind": "window", "app": w["app"], "title": w["title"], "markable": not covered,
            "label": f"the {w['app']} window" + (f" “{w['title'][:80]}”" if w["title"] else ""),
            "screen": display_for(w["x"] + w["w"] / 2, w["y"] + w["h"] / 2)["n"],
            "x": w["x"], "y": w["y"], "w": w["w"], "h": w["h"], "path": got[0], "img_w": got[1], "img_h": got[2]}
    LAST.parent.mkdir(parents=True, exist_ok=True)
    LAST.write_text(json.dumps({"parts": [{k: v for k, v in part.items() if k != "path"}], "at": time.time()}))
    return True, "", [part]


def find_windows(query: str) -> list[dict]:
    """Windows matching an id from list_windows, an app name, or words from a title, best first. Apps keep
    hidden helper windows titled with the app's name, so among equal matches the bigger window wins."""
    q = str(query or "").strip().lower()
    wins = list_windows()
    if q.isdigit():
        return [w for w in wins if w["id"] == int(q)]
    words, scored = q.split(), []
    for w in wins:
        app, title = w["app"].lower(), w["title"].lower()
        score = (3 if q == app else 2 if q and q in app else 0) + (1 if q and q in title and q != app and title != app else 0)
        if not score and words and all(x in f"{app} {title}" for x in words):
            score = 1
        if score:
            scored.append((-score, not w["visible"], -w["w"] * w["h"], w["order"], w))
    return [x[-1] for x in sorted(scored, key=lambda x: x[:4])]


def find_window(query: str) -> dict | None:
    found = find_windows(query)
    return found[0] if found else None


def _blank(path: str, w: int, h: int) -> bool:
    """A picture that's (nearly) one flat colour: some apps' minimized or helper windows capture that way.
    Flat JPEGs are tiny (about 0.02 bytes a pixel against 0.15 for a real window)."""
    return os.path.getsize(path) < 0.03 * w * h


def _shot(cmd: list, folder: Path) -> tuple[str, int, int] | None:
    png = folder / f"screen-{time.time_ns()}.png"
    if subprocess.run(cmd + [str(png)], capture_output=True, timeout=15).returncode != 0 or not png.exists():
        return None
    jpg = png.with_suffix(".jpg")
    subprocess.run(["sips", "-Z", str(MAX_SIDE), "-s", "format", "jpeg", "-s", "formatOptions", "80", str(png),
                    "--out", str(jpg)], capture_output=True, timeout=20)
    png.unlink(missing_ok=True)
    size = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", str(jpg)],
                          capture_output=True, text=True, timeout=10).stdout
    try:
        return str(jpg), int(size.split("pixelWidth:")[1].split()[0]), int(size.split("pixelHeight:")[1].split()[0])
    except (IndexError, ValueError):
        return None


def capture(what: str = "window", window: str = "") -> tuple[bool, str, list[dict]]:
    """Screenshots sized for Claude: (ok, error, pictures). `what` is "window" (the front one, or `window`:
    an id, app name or title words), "screen" (the whole display it's on) or "all_screens" (one picture per
    display). Each picture says where it sits on screen, for markup, and whether marks can go on it."""
    if not allowed():
        return False, PERMISSION_HELP, []
    front = front_window()
    win, others = front, []
    if window:
        found = find_windows(window)
        if not found:
            return False, f"No open window matches “{window}”. Call list_windows to see what's open.", []
        win, others = found[0], found[1:4]
    folder = Path(tempfile.gettempdir()) / "workbench-screen"
    folder.mkdir(exist_ok=True)
    for old in folder.glob("*"):  # only ever the latest
        old.unlink(missing_ok=True)

    plan = []  # (command, info)
    if what == "all_screens":
        for d in displays():
            plan.append((["screencapture", "-x", "-R", f"{d['x']:.0f},{d['y']:.0f},{d['w']:.0f},{d['h']:.0f}"],
                         {"kind": "screen", "screen": d["n"], "label": f"screen {d['n']} ({d['where']})",
                          "markable": True, **{k: d[k] for k in ("x", "y", "w", "h")}}))
    elif what == "screen" or not win:
        d = display_for(win["x"] + win["w"] / 2, win["y"] + win["h"] / 2) if win else displays()[0]
        plan.append((["screencapture", "-x", "-R", f"{d['x']:.0f},{d['y']:.0f},{d['w']:.0f},{d['h']:.0f}"],
                     {"kind": "screen", "screen": d["n"], "label": f"screen {d['n']} ({d['where']})",
                      "markable": True, **{k: d[k] for k in ("x", "y", "w", "h")}}))
    else:
        visible = win.get("visible", True)
        is_front = (bool(front) and win["id"] == front["id"]) or (visible and not win.get("covered", True))
        label = f"the {win['app']} window" + (f" “{win['title']}”" if win["title"] else "")
        note = ("" if is_front else
                " It's behind other windows, so marks can't be drawn on it; describe where things are instead, or "
                "ask the user to bring it to the front and look again." if visible else
                " It isn't on screen (minimized or on another desktop), so this is how it last looked and marks "
                "can't be drawn on it.")
        plan.append((["screencapture", "-x", "-o", f"-l{win['id']}"],
                     {"kind": "window", "app": win["app"], "title": win["title"], "label": label, "note": note,
                      "markable": is_front, "screen": display_for(win["x"] + win["w"] / 2, win["y"] + win["h"] / 2)["n"],
                      **{k: win[k] for k in ("x", "y", "w", "h")}}))

    parts = []
    for cmd, info in plan:
        got = _shot(cmd, folder)
        if got and info["kind"] == "window" and _blank(*got) and others:  # try the next matching window
            nxt = others.pop(0)
            Path(got[0]).unlink(missing_ok=True)
            return capture(what, str(nxt["id"]))
        if got:
            info["path"], info["img_w"], info["img_h"] = got
            if info["kind"] == "window" and _blank(*got):
                info["note"] = (" It came back blank (the app doesn't draw it while it's minimized or hidden): ask "
                                "the user to bring it up, then look again.")
            parts.append(info)
    if not parts:
        return False, "Couldn't take a screenshot.", []
    LAST.parent.mkdir(parents=True, exist_ok=True)
    LAST.write_text(json.dumps({"parts": [{k: v for k, v in p.items() if k != "path"} for p in parts],
                                "at": time.time()}))
    return True, "", parts


CIRCLED = LAST.parent / "circled.json"


def capture_circled(screen_n: int, region: dict) -> tuple[bool, str]:
    """The user circled `region` (global points) on screen `screen_n`. Save a close-up of it and the whole
    screen around it (the user's ring shows in both) for look_at_screen(what="circled")."""
    if not allowed():
        return False, PERMISSION_HELP
    d = next((x for x in displays() if x["n"] == screen_n), None) or displays()[0]
    pad = 28
    x0, y0 = max(d["x"], region["x"] - pad), max(d["y"], region["y"] - pad)
    x1 = min(d["x"] + d["w"], region["x"] + region["w"] + pad)
    y1 = min(d["y"] + d["h"], region["y"] + region["h"] + pad)
    folder = Path(tempfile.gettempdir()) / "workbench-circled"
    folder.mkdir(exist_ok=True)
    for old in folder.glob("*"):
        old.unlink(missing_ok=True)
    close = _shot(["screencapture", "-x", "-R", f"{x0:.0f},{y0:.0f},{x1 - x0:.0f},{y1 - y0:.0f}"], folder)
    whole = _shot(["screencapture", "-x", "-R", f"{d['x']:.0f},{d['y']:.0f},{d['w']:.0f},{d['h']:.0f}"], folder)
    if not close or not whole:
        return False, "Couldn't take a screenshot."
    k = whole[1] / d["w"]  # whole-screen picture pixels per point
    where = (f"{(region['x'] - d['x']) * k:.0f},{(region['y'] - d['y']) * k:.0f} to "
             f"{(region['x'] + region['w'] - d['x']) * k:.0f},{(region['y'] + region['h'] - d['y']) * k:.0f}")
    parts = [
        {"kind": "screen", "screen": d["n"], "markable": True, "label": "what the user drew on (their yellow strokes), close up",
         "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0, "path": close[0], "img_w": close[1], "img_h": close[2]},
        {"kind": "screen", "screen": d["n"], "markable": True,
         "label": f"the whole of screen {d['n']} for context (their strokes cover {where} in this picture)",
         "x": d["x"], "y": d["y"], "w": d["w"], "h": d["h"], "path": whole[0], "img_w": whole[1], "img_h": whole[2]},
    ]
    CIRCLED.parent.mkdir(parents=True, exist_ok=True)
    CIRCLED.write_text(json.dumps({"parts": parts, "at": time.time()}))
    return True, ""


def take_circled() -> list[dict]:
    """The pictures from the last circle (once, and only if it's fresh); they become the marks' reference."""
    try:
        data = json.loads(CIRCLED.read_text())
        CIRCLED.unlink(missing_ok=True)
    except (OSError, ValueError):
        return []
    parts = [p for p in data.get("parts", []) if Path(p.get("path", "")).exists()]
    if not parts or time.time() - data.get("at", 0) > 300:
        return []
    LAST.write_text(json.dumps({"parts": [{k: v for k, v in p.items() if k != "path"} for p in parts], "at": time.time()}))
    return parts


def describe_windows() -> str:
    """list_windows as text for Claude."""
    if not allowed():
        return PERMISSION_HELP
    wins = list_windows()
    if not wins:
        return "No windows with titles are open."
    ds = displays()
    lines = [f"Screens: " + "; ".join(f"screen {d['n']} ({d['where']}, {d['w']:.0f}×{d['h']:.0f})" for d in ds), ""]
    for w in wins:
        where = (("front window" if w is wins[0] else "partly behind other windows" if w["covered"] else "in view") + (f", screen {w['screen']}" if len(ds) > 1 else "")
                 if w["visible"] else "not on screen (minimized or on another desktop)")
        lines.append(f"[{w['id']}] {w['app']} — “{w['title'][:90]}” — {where}")
    return "\n".join(lines)


def last_capture() -> dict:
    try:
        return json.loads(LAST.read_text())
    except (OSError, ValueError):
        return {}


MAX_MARKS = 40
KINDS = {"circle", "box", "arrow", "underline", "label", "highlight", "strike", "cross", "check", "number",
         "line", "path", "spotlight", "note"}
COLOR_RE = re.compile(r"#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|(rgb|hsl)a?\([\d\s.,%deg/]+\)")


def place_marks(marks: list) -> list[tuple[dict, list]]:
    """Turn marks in screenshot pixels into points on the displays the screenshots came from. A mark's
    `image` (1 = first) says which picture it's on. Returns [(display, marks relative to its top-left)]."""
    parts = last_capture().get("parts") or []
    if not parts or not marks:
        return []
    by_display: dict = {}
    ds = displays()
    for m in marks[:MAX_MARKS]:
        if not isinstance(m, dict):
            continue
        try:
            pts = [(float(a), float(b)) for a, b in (m.get("points") or [])[:400]]
            if "x" not in m and pts:  # a freehand path can be given by its points alone
                m = {**m, "x": pts[0][0], "y": pts[0][1]}
            part = parts[min(len(parts), max(1, int(m.get("image") or 1))) - 1]
            if not part.get("markable"):
                continue
            s = part["w"] / max(1, part["img_w"])  # points per screenshot pixel
            d = next((x for x in ds if x["n"] == part["screen"]), None) or display_for(part["x"], part["y"])
            ox, oy = part["x"] - d["x"], part["y"] - d["y"]
            kind = str(m.get("kind") or "circle")
            color = str(m.get("color") or "red").strip()
            p = {"kind": kind if kind in KINDS else "circle", "text": str(m.get("text") or "")[:300],
                 "color": color if COLOR_RE.fullmatch(color) else "red",
                 "x": ox + float(m["x"]) * s, "y": oy + float(m["y"]) * s,
                 "w": float(m.get("w") or 0) * s, "h": float(m.get("h") or 0) * s}
            if p["kind"] in ("arrow", "line"):
                p["x2"], p["y2"] = ox + float(m.get("x2", m["x"])) * s, oy + float(m.get("y2", m["y"])) * s
            if pts:
                p["points"] = [[round(ox + a * s, 1), round(oy + b * s, 1)] for a, b in pts]
        except (KeyError, TypeError, ValueError, IndexError):
            continue
        by_display.setdefault(d["id"], (d, []))[1].append(p)
    return list(by_display.values())


def main_display_height() -> float:
    return next((d["h"] for d in displays() if d["main"]), 0.0)



def read_text(screen_n: int, region: dict) -> tuple[str, str]:
    """Copy text from the screen: the words inside `region` (global points) on screen `screen_n`, read by the
    Mac's own text recognition (Vision, on this Mac; nothing is sent anywhere). Returns (text, error)."""
    png, err = capture_region(screen_n, region)
    if not png:
        return "", err
    try:
        return _ocr(png), ""
    finally:
        png.unlink(missing_ok=True)


_VISION: dict = {}


def _ocr(path: Path) -> str:
    """Lines top to bottom, words on one line left to right; a blank line where the gap is wider than a line."""
    boxes = ocr_boxes(path)
    if not boxes:
        return ""
    rows = ocr_rows(boxes)
    out, last_bottom = [], None
    for row in rows:
        t, h = row[0]["t"], max(b["h"] for b in row)
        if last_bottom is not None and t - last_bottom > h * 1.1:
            out.append("")
        out.append("  ".join(b["s"] for b in row) if len(row) > 1 else row[0]["s"])
        last_bottom = t + h
    return "\n".join(out).strip()


def ocr_rows(boxes: list[dict]) -> list[list[dict]]:
    """Pieces of text grouped into rows (same row if it starts within half a line), each left to right."""
    rows: list[list[dict]] = []
    for b in sorted(boxes, key=lambda b: (b["t"], b["x"])):
        if rows and abs(b["t"] - rows[-1][0]["t"]) < rows[-1][0]["h"] / 2:
            rows[-1].append(b)
        else:
            rows.append([b])
    for row in rows:
        row.sort(key=lambda b: b["x"])
    return rows


def ocr_boxes(path: Path, roi: tuple[float, float, float, float] | None = None) -> list[dict]:
    """Each piece of text the Mac finds: t (top), h, x, w as 0-1 of the picture, s the text.
    roi (x, top, w, h as 0-1) reads only that part; positions still come back as parts of the whole picture."""
    import objc
    from Foundation import NSURL
    if not _VISION:  # the framework itself, so no extra package is needed
        objc.loadBundle("Vision", _VISION, bundle_path="/System/Library/Frameworks/Vision.framework")
    req = _VISION["VNRecognizeTextRequest"].alloc().init()
    req.setRecognitionLevel_(0)  # accurate
    req.setUsesLanguageCorrection_(True)
    if roi:
        rx, rt, rw, rh = roi
        req.setRegionOfInterest_(((rx, 1 - rt - rh), (rw, rh)))  # Vision's origin is the bottom left
    handler = _VISION["VNImageRequestHandler"].alloc().initWithURL_options_(NSURL.fileURLWithPath_(str(path)), {})
    handler.performRequests_error_([req], None)
    boxes = []
    for o in req.results() or []:
        top = o.topCandidates_(1)
        if not top:
            continue
        b = o.boundingBox()  # 0-1 of the region read, origin at the bottom left
        x, y, w, h = b.origin.x, b.origin.y, b.size.width, b.size.height
        if roi:
            x, w = rx + x * rw, w * rw
            y, h = (1 - rt - rh) + y * rh, h * rh
        boxes.append({"t": 1 - (y + h), "h": h, "x": x, "w": w, "s": str(top[0].string())})
    return boxes


def capture_region(screen_n: int, region: dict) -> tuple[Path | None, str]:
    """A full-resolution PNG of `region` (global points) on screen `screen_n`; the caller deletes it."""
    if not allowed():
        return None, PERMISSION_HELP
    d = next((x for x in displays() if x["n"] == screen_n), None) or displays()[0]
    x0, y0 = max(d["x"], region["x"]), max(d["y"], region["y"])
    x1, y1 = min(d["x"] + d["w"], region["x"] + region["w"]), min(d["y"] + d["h"], region["y"] + region["h"])
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None, "That box was too small."
    png = Path(tempfile.gettempdir()) / f"tether-box-{time.time_ns()}.png"
    r = subprocess.run(["screencapture", "-x", "-R", f"{x0:.0f},{y0:.0f},{x1 - x0:.0f},{y1 - y0:.0f}", str(png)],
                       capture_output=True, timeout=15)
    if r.returncode != 0 or not png.exists():
        return None, "Couldn't take the screenshot."
    return png, ""
