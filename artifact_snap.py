"""
Draw a sealed artifact page off screen with WebKit (the engine the View tab uses) and save it as a JPEG, so Claude
can see what it built. Run as its own process: python artifact_snap.py page.html out.jpg [width] [dark|light]
Prints one JSON line: {"w", "h", "cut", "errors"} or {"error"}.
"""

import json
import sys
import time

import AppKit
import WebKit
from Foundation import NSURL, NSDate, NSMakeRect, NSMakeSize, NSRunLoop

MAX_H = 2400


def pump(sec: float) -> None:
    end = time.time() + sec
    while time.time() < end:
        NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.03))


def wait(res: dict, key: str, sec: float = 8) -> None:
    end = time.time() + sec
    while key not in res and time.time() < end:
        pump(0.03)


def main() -> None:
    src, out = sys.argv[1], sys.argv[2]
    width = int(sys.argv[3]) if len(sys.argv) > 3 else 600
    dark = len(sys.argv) > 4 and sys.argv[4] == "dark"
    opts = json.loads(sys.argv[5]) if len(sys.argv) > 5 else {}  # {"vh", "top"}: just one screen of the page, scrolled to top
    app = AppKit.NSApplication.sharedApplication()
    app.setActivationPolicy_(AppKit.NSApplicationActivationPolicyProhibited)  # no Dock icon, no focus
    cfg = WebKit.WKWebViewConfiguration.alloc().init()
    wv = WebKit.WKWebView.alloc().initWithFrame_configuration_(NSMakeRect(0, 0, width, 900), cfg)
    win = AppKit.NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
        NSMakeRect(-30000, -30000, width, 900), AppKit.NSWindowStyleMaskBorderless, AppKit.NSBackingStoreBuffered, False)
    win.setContentView_(wv)
    win.orderBack_(None)
    # Tether's light or dark, as the View tab has it; a page that follows the theme looks the same in both
    wv.setAppearance_(AppKit.NSAppearance.appearanceNamed_(AppKit.NSAppearanceNameDarkAqua if dark else AppKit.NSAppearanceNameAqua))
    wv.loadHTMLString_baseURL_(open(src, encoding="utf-8").read(), NSURL.URLWithString_("https://artifact.tether.invalid/"))  # a real origin, so errors say what broke; CSP blocks loads
    t0 = time.time()
    while wv.isLoading() and time.time() - t0 < 10:
        pump(0.05)
    pump(0.8)  # scripts that draw after load
    res: dict = {}
    wv.evaluateJavaScript_completionHandler_(
        "JSON.stringify({h: document.body ? Math.ceil(Math.max(document.body.scrollHeight, document.body.getBoundingClientRect().bottom)) : 0,"
        " errors: (window.__tetherErrors || []).slice(0, 10)})", lambda v, e: res.__setitem__("info", v))
    wait(res, "info")
    info = json.loads(res.get("info") or "{}")
    full = int(info.get("h") or 900)
    h = max(200, min(MAX_H, min(int(opts["vh"]), full) if opts else full))  # a short page isn't padded out to the Shelf's height
    win.setContentSize_(NSMakeSize(width, h))
    wv.setFrame_(NSMakeRect(0, 0, width, h))
    pump(0.3)
    if opts:
        wv.evaluateJavaScript_completionHandler_(f"scrollTo(0, {int(opts.get('top') or 0)}); 1", lambda v, e: res.__setitem__("scrolled", 1))
        wait(res, "scrolled", 3)
        pump(0.2)
    conf = WebKit.WKSnapshotConfiguration.alloc().init()
    conf.setSnapshotWidth_(width)  # 1x: enough to judge layout, a quarter of the tokens of 2x
    wv.takeSnapshotWithConfiguration_completionHandler_(conf, lambda img, err: res.update(img=img, err=err))
    wait(res, "img", 10)
    img = res.get("img")
    if img is None:
        print(json.dumps({"error": f"Snapshot failed: {res.get('err')}"}))
        return
    rep = AppKit.NSBitmapImageRep.imageRepWithData_(img.TIFFRepresentation())
    jpg = rep.representationUsingType_properties_(AppKit.NSBitmapImageFileTypeJPEG, {AppKit.NSImageCompressionFactor: 0.8})
    jpg.writeToFile_atomically_(out, True)
    w = min(width, 800) if opts else width  # a note picture: a wide full-window Shelf is shrunk to keep it cheap
    if rep.pixelsWide() > w:  # a Retina snapshot comes back at 2x; 1x is enough to judge layout
        import subprocess
        subprocess.run(["sips", "--resampleWidth", str(w), out], capture_output=True)
    print(json.dumps({"w": w, "h": int(round(rep.pixelsHigh() * w / rep.pixelsWide())), "cut": full > MAX_H and not opts, "errors": info.get("errors") or []}))


if __name__ == "__main__":
    main()
