"""The Dock icon breathes while Claude works: a soft glow in the logo's blue swells and fades about every 2 s.

Frames are drawn once from assets/icon.png and swapped on a main-thread timer; when nothing is working
the plain icon goes back. Everything here runs on the main (AppKit) thread.
"""
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
ICON = HERE / "assets" / "icon.png"
FPS, PERIOD, SIZE = 12, 2.0, 512     # 24 frames a cycle; 512 px covers the Dock at full magnification on Retina
GLOW = (0.17, 0.70, 0.84)            # a brighter take on the logo's teal-blue

_frames: list = []
_plain = None
_timer = None
_i = 0


def _draw(t: float):
    """One frame: t from 0 to 1 is how strong the pulse is."""
    import AppKit
    from Foundation import NSMakeRect
    art = AppKit.NSImage.alloc().initWithContentsOfFile_(str(ICON))
    img = AppKit.NSImage.alloc().initWithSize_((SIZE, SIZE))
    img.lockFocus()
    s = SIZE / 1024
    tile = NSMakeRect(100 * s, 100 * s, 824 * s, 824 * s)
    # the glow: the tile's shape with a wide blurred shadow behind it, stronger as t rises
    AppKit.NSGraphicsContext.saveGraphicsState()
    sh = AppKit.NSShadow.alloc().init()
    sh.setShadowBlurRadius_((30 + 40 * t) * s)
    sh.setShadowOffset_((0, 0))
    sh.setShadowColor_(AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(*GLOW, t))
    sh.set()
    AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(*GLOW, t).set()
    shape = AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(tile, 185 * s, 185 * s)
    for _ in range(3):  # stacked, so the halo reads at Dock size
        shape.fill()
    AppKit.NSGraphicsContext.restoreGraphicsState()
    # the icon itself, breathing a touch larger at the peak
    k = 1 + 0.05 * t
    d = SIZE * (k - 1) / 2
    art.drawInRect_fromRect_operation_fraction_(NSMakeRect(-d, -d, SIZE * k, SIZE * k), NSMakeRect(0, 0, 0, 0),
                                                AppKit.NSCompositingOperationSourceOver, 1.0)
    e = -d + 100 * s * k  # the tile's edge after the breathe
    rim = AppKit.NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(NSMakeRect(e, e, 824 * s * k, 824 * s * k), 185 * s * k, 185 * s * k)
    rim.setLineWidth_(6 * s)
    AppKit.NSColor.colorWithSRGBRed_green_blue_alpha_(*GLOW, 0.85 * t).set()
    rim.stroke()
    img.unlockFocus()
    return img


def frames() -> list:
    global _frames
    if not _frames and ICON.exists():
        n = int(FPS * PERIOD)
        _frames = [_draw((1 - math.cos(2 * math.pi * i / n)) / 2) for i in range(n)]  # eases in and out
    return _frames


def _plain_icon():
    global _plain
    if _plain is None and ICON.exists():
        import AppKit
        _plain = AppKit.NSImage.alloc().initWithContentsOfFile_(str(ICON))
    return _plain


def _tick(_t=None) -> None:
    global _i
    import AppKit
    f = frames()
    if f:
        _i = (_i + 1) % len(f)
        AppKit.NSApplication.sharedApplication().setApplicationIconImage_(f[_i])


def set_working(on: bool) -> None:
    """Main thread. Start the pulse, or stop it and put the plain icon back."""
    global _timer, _i
    import AppKit
    from Foundation import NSTimer, NSRunLoop, NSRunLoopCommonModes
    if on and _timer is None and frames():
        _i = 0
        _timer = NSTimer.timerWithTimeInterval_repeats_block_(1 / FPS, True, _tick)
        NSRunLoop.mainRunLoop().addTimer_forMode_(_timer, NSRunLoopCommonModes)  # keeps going during drags and menus
    elif not on and _timer is not None:
        _timer.invalidate()
        _timer = None
        if _plain_icon():
            AppKit.NSApplication.sharedApplication().setApplicationIconImage_(_plain_icon())
