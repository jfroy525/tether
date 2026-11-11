"""Waiting on you panel: a small panel that floats over other apps while Tether is in the Dock or another app is in
front, listing what needs you (questions, approvals, handoffs, failed jobs) with buttons to answer from where you are.

It is a native non-activating panel (like Spotlight), not a second pywebview window: it shows without taking focus,
its buttons work without bringing Tether forward, and it takes the keyboard only when you click into it, so you can
type a reply without Tether's main window jumping in front of the app you're in.

The page (ui/panel.html) talks to Python with window.webkit.messageHandlers.tether.postMessage(JSON text); Python
calls window.render(state) in it. The main window's page sends the list (Api.panel_items) and does the answering
(Api._panel_act -> a "panel_act" event). Settings › Notifications holds the switches.
Everything here runs on the main thread (AppHelper.callAfter from other threads)."""
from __future__ import annotations

import json
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE / "ui" / "panel.html"
M = 16            # transparent margin around the panel inside the window, for its shadow (panel.html uses the same)
PANEL_W = 352     # the panel's own width
W = PANEL_W + 2 * M
GAP = 10          # from the screen edge to the panel
TICK = 0.5        # seconds between checks of whether Tether is away
KINDS = ("ask", "perm", "handoff", "job", "done")

_api = None
_panel = _web = _handler = _timer = None
_ready = False
_items: list = []
_closed: set = set()   # ids showing when you clicked close; the panel stays away until something new comes
_shown = False
_h = 120              # the page's height, as it last reported
_drag = False
_last_state = ""
_hold_until = 0.0
_want_key = False      # the Reply box asked for the keyboard
_prev_app = None       # the app you were in when you clicked into the Reply box; it gets the keyboard back
_below = 0             # the window Tether's main window stays behind while you type


def setup(api) -> None:
    """Main thread, once at start: remember the app and start checking."""
    global _api, _timer
    from Foundation import NSTimer, NSRunLoop, NSRunLoopCommonModes
    _api = api
    if _timer is None:
        _timer = NSTimer.timerWithTimeInterval_repeats_block_(TICK, True, lambda _t: _tick())
        NSRunLoop.mainRunLoop().addTimer_forMode_(_timer, NSRunLoopCommonModes)


def set_items(items: list) -> None:
    """Any thread: the main page's list changed."""
    from PyObjCTools import AppHelper
    global _items
    _items = list(items or [])
    AppHelper.callAfter(_tick)


def refresh() -> None:
    """Any thread: settings changed."""
    from PyObjCTools import AppHelper
    global _last_state
    _last_state = ""
    AppHelper.callAfter(_tick)


# ---------- what to show, and when ----------
def _visible_items() -> list:
    s = _api.settings
    kinds = set(s.get("panel_kinds") or [])
    return [x for x in _items if x.get("cat") in kinds]


def _away() -> bool:
    """Tether is in the Dock, hidden, or another app is in front (and the mini window isn't floating on top)."""
    import AppKit
    app = AppKit.NSApplication.sharedApplication()
    n = _api._window.native if _api and _api._window else None
    if not n:
        return False
    if n.isMiniaturized() or not n.isVisible() or app.isHidden():
        return True
    if _want_key and _panel is not None and _panel.isKeyWindow():
        return True  # you're typing in the panel: typing made Tether active, but you're still away
    if app.isActive():
        return False
    if _api._mini_on and _api.settings.get("mini_on_top"):
        return False  # the mini window floats above other apps already
    return True


def _tick() -> None:
    global _closed
    if not _api:
        return
    try:
        items = _visible_items()
        ids = {x["id"] for x in items}
        if _closed and not ids <= _closed:
            _closed = set()  # something new came in
        want = bool(_api.settings.get("waiting_panel")) and bool(items) and _away() and not (ids <= _closed)
        if want:
            _show(items)
        elif _shown and not _drag and time.time() > _hold_until:
            _hide()
        elif _shown and _ready:
            _push(items)  # the last item just went: let the page show "Sent" before the panel leaves
    except Exception as e:  # noqa: BLE001  the panel must never take the app down
        print(f"[panel] {e}", flush=True)


# ---------- the window ----------
def _make() -> None:
    global _panel, _web, _handler
    import AppKit
    import objc
    import WebKit
    from Foundation import NSObject, NSURL

    class TetherPanelWeb(WebKit.WKWebView):
        def acceptsFirstMouse_(self, event):  # a click on a button works the first time, without Tether in front
            return True

        def needsPanelToBecomeKey(self):  # only the Reply box needs the keyboard (the page says so first, "key")
            return _want_key

    class TetherPanelWindow(AppKit.NSPanel):
        def canBecomeKeyWindow(self):  # borderless panels can't by default; the Reply box needs the keyboard
            return True

        def canBecomeMainWindow(self):
            return False

    class TetherPanelHandler(NSObject):
        def userContentController_didReceiveScriptMessage_(self, ucc, msg):
            try:
                _message(json.loads(str(msg.body())))
            except Exception as e:  # noqa: BLE001
                print(f"[panel] message: {e}", flush=True)

    globals().update(TetherPanelWeb=TetherPanelWeb, TetherPanelWindow=TetherPanelWindow)
    mask = AppKit.NSWindowStyleMaskBorderless | AppKit.NSWindowStyleMaskNonactivatingPanel
    p = TetherPanelWindow.alloc().initWithContentRect_styleMask_backing_defer_(AppKit.NSMakeRect(0, 0, W, _h), mask,
                                                                                 AppKit.NSBackingStoreBuffered, False)
    p.setFloatingPanel_(True)
    p.setBecomesKeyOnlyIfNeeded_(True)       # a button click doesn't take the keyboard from the app you're in
    p.setLevel_(AppKit.NSStatusWindowLevel)  # above ordinary and floating windows, like a notification
    p.setHidesOnDeactivate_(False)            # Tether is usually not the active app while this shows
    p.setCanHide_(False)                      # stays up when you hide Tether (⌘H), which is when you need it
    p.setOpaque_(False)
    p.setBackgroundColor_(AppKit.NSColor.clearColor())
    p.setHasShadow_(False)                    # the page draws its own shadow inside the margin
    p.setReleasedWhenClosed_(False)
    p.setCollectionBehavior_(AppKit.NSWindowCollectionBehaviorCanJoinAllSpaces
                             | AppKit.NSWindowCollectionBehaviorFullScreenAuxiliary
                             | AppKit.NSWindowCollectionBehaviorIgnoresCycle)
    p.setTitle_("Tether · Waiting on you")
    cfg = WebKit.WKWebViewConfiguration.alloc().init()
    _handler = TetherPanelHandler.alloc().init()
    cfg.userContentController().addScriptMessageHandler_name_(_handler, "tether")
    web = TetherPanelWeb.alloc().initWithFrame_configuration_(AppKit.NSMakeRect(0, 0, W, _h), cfg)
    web.setValue_forKey_(False, "drawsBackground")
    # macOS reports this panel as covered even while it's on screen (a floating window of a background app), and
    # WebKit then treats the page as hidden and doesn't paint it. The panel is only up when it should be seen.
    if web.respondsToSelector_("_setWindowOcclusionDetectionEnabled:"):
        web._setWindowOcclusionDetectionEnabled_(False)
    web.setAutoresizingMask_(AppKit.NSViewWidthSizable | AppKit.NSViewHeightSizable)
    p.setContentView_(web)
    web.loadFileURL_allowingReadAccessToURL_(NSURL.fileURLWithPath_(str(PAGE)), NSURL.fileURLWithPath_(str(HERE)))
    _panel, _web = p, web
    _ = objc  # keep the import: pyobjc needs it loaded for the subclasses above


def _screen():
    import AppKit
    return AppKit.NSScreen.mainScreen() or AppKit.NSScreen.screens()[0]


def _frame(h: float):
    """Where the window goes for Settings › Notifications › Where it shows, at height h."""
    import AppKit
    sc = _screen()
    vf, full = sc.visibleFrame(), sc.frame()
    x0, y0, vw, vh = vf.origin.x, vf.origin.y, vf.size.width, vf.size.height
    where = _api.settings.get("panel_where") or "tr"
    xy = _api.settings.get("panel_xy") or []
    left, right, top, bottom = x0 + GAP - M, x0 + vw - GAP + M - W, y0 + vh - GAP + M - h, y0 + GAP - M
    if where == "drag" and len(xy) == 2:
        x = x0 - M + float(xy[0]) * max(1, vw - PANEL_W)
        y = y0 + vh + M - float(xy[1]) * vh - h
    elif where == "dock":
        dl, dr = x0 - full.origin.x, (full.origin.x + full.size.width) - (x0 + vw)
        if dl > 0 or dr > 0:  # Dock on a side: next to it, halfway up
            x, y = (left if dl > 0 else right), y0 + (vh - h) / 2
        else:
            x, y = x0 + (vw - W) / 2, bottom
    else:
        x = left if where in ("tl", "bl") else right
        y = bottom if where in ("bl", "br") else top
    x = min(max(x, x0 - M), x0 + vw + M - W)
    y = min(max(y, y0 - M), y0 + vh + M - h)
    return AppKit.NSMakeRect(round(x), round(y), W, round(h))


def _state(items: list) -> dict:
    import AppKit
    s = _api.settings
    theme = s.get("theme") or "system"
    if theme == "system":
        ap = AppKit.NSApplication.sharedApplication().effectiveAppearance()
        best = ap.bestMatchFromAppearancesWithNames_([AppKit.NSAppearanceNameAqua, AppKit.NSAppearanceNameDarkAqua])
        theme = "dark" if best == AppKit.NSAppearanceNameDarkAqua else "light"
    vh = _screen().visibleFrame().size.height
    return {"items": items, "theme": theme, "accent": s.get("accent") or "", "scale": (s.get("text_size") or 100) / 100,
            "private": bool(s.get("panel_private")), "start": s.get("panel_start") or "panel",
            "max_h": int(vh * 0.72), "now": time.time()}


def _show(items: list) -> None:
    global _shown
    if _panel is None:
        _make()
    _push(items)
    if not _shown:
        if not _drag:
            _panel.setFrame_display_(_frame(_h), True)
        _panel.orderFrontRegardless()  # shows it without making Tether the active app or taking the keyboard
        _shown = True
        if _ready:
            _web.evaluateJavaScript_completionHandler_("window.entered && window.entered()", None)


def _push(items: list) -> None:
    """Send the list to the page, only when something changed."""
    global _last_state
    if not _ready:
        return
    st = _state(items)
    key = json.dumps({**st, "now": 0}, sort_keys=True)
    if key != _last_state:
        _last_state = key
        _web.evaluateJavaScript_completionHandler_(f"window.render({json.dumps(st)})", None)


def _front_other_window() -> int:
    """The frontmost ordinary window of another app."""
    import os
    import Quartz
    for w in Quartz.CGWindowListCopyWindowInfo(Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements, Quartz.kCGNullWindowID) or []:
        if w.get("kCGWindowLayer") == 0 and w.get("kCGWindowOwnerPID") != os.getpid():
            return int(w.get("kCGWindowNumber") or 0)
    return 0


def _take_keyboard() -> None:
    """macOS gives a panel the keyboard only by making Tether the active app, which would bring Tether's main window
    up. So note the app you're in and the window on top, take the keyboard, and keep the main window behind it."""
    global _want_key, _prev_app, _below
    import AppKit
    from PyObjCTools import AppHelper
    if _panel is None:
        return
    app = AppKit.NSApplication.sharedApplication()
    if not app.isActive():
        front = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication()
        _prev_app = front if front and front.processIdentifier() != AppKit.NSProcessInfo.processInfo().processIdentifier() else None
        _below = _front_other_window()
    _want_key = True
    _panel.makeKeyWindow()

    def keep_back():
        n = _api._window.native if _api and _api._window else None
        if n and _below and n.isVisible() and not n.isMiniaturized():
            n.orderWindow_relativeTo_(AppKit.NSWindowBelow, _below)
        _panel.orderFrontRegardless()
    for delay in (0.0, 0.15, 0.4):  # activation settles over a few run loop turns
        AppHelper.callLater(delay, keep_back)


def _give_back() -> None:
    """Done typing (sent, or clicked away): the app you were in gets the keyboard back."""
    global _want_key, _prev_app
    _want_key = False
    prev, _prev_app = _prev_app, None
    import AppKit
    app = AppKit.NSApplication.sharedApplication()
    if not app.isActive():
        return
    if prev is not None and not prev.isTerminated():
        if app.respondsToSelector_("yieldActivationToApplication:"):  # macOS 14+: an app hands activation over
            app.yieldActivationToApplication_(prev)
        prev.activateWithOptions_(0)
    from PyObjCTools import AppHelper
    AppHelper.callLater(0.4, lambda: app.isActive() and not _want_key and app.deactivate())  # only if the switch didn't happen


def _hide() -> None:
    global _shown
    if _want_key:
        _give_back()
    if _panel is not None:
        _panel.orderOut_(None)
    _shown = False


# ---------- messages from the page ----------
def _message(m: dict) -> None:
    global _ready, _h, _drag, _closed, _last_state, _hold_until, _want_key
    t = m.get("t")
    if t == "ready":
        _ready, _last_state = True, ""
        _tick()
    elif t == "size":
        _h = max(60, float(m.get("h") or 0) + 2 * M)
        if _panel is not None and not _drag:
            f = _panel.frame()
            if _shown:
                where = _api.settings.get("panel_where") or "tr"
                import AppKit
                nf = _frame(_h)
                if where in ("tr", "tl", "drag"):  # keep the top edge where it is
                    nf = AppKit.NSMakeRect(f.origin.x, f.origin.y + f.size.height - _h, W, _h)
                _panel.setFrame_display_animate_(nf, True, False)
            else:
                _panel.setFrame_display_(_frame(_h), True)
    elif t == "act":
        _hold_until = time.time() + 1.6
        _api._panel_act(m.get("id", ""), m.get("act", ""), m.get("text", ""), m.get("sid", ""))
    elif t == "key":  # pressing into the Reply box: the panel takes the keyboard (only then)
        if m.get("on"):
            _take_keyboard()
        else:
            _give_back()
    elif t == "close":
        _closed = {x["id"] for x in _visible_items()}
        _hide()
    elif t == "drag":
        _drag = True
        f = _panel.frame()
        _panel.setFrameOrigin_((f.origin.x + float(m.get("dx", 0)), f.origin.y - float(m.get("dy", 0))))
    elif t == "drag_end":
        _drag = False
        f, vf = _panel.frame(), _screen().visibleFrame()
        fx = (f.origin.x + M - vf.origin.x) / max(1, vf.size.width - PANEL_W)
        fy = (vf.origin.y + vf.size.height - (f.origin.y + f.size.height - M)) / max(1, vf.size.height)
        _api.settings["panel_where"] = "drag"
        _api.settings["panel_xy"] = [round(min(max(fx, 0), 1), 4), round(min(max(fy, 0), 1), 4)]
        _api._save()
