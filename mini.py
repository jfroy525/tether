"""Mini window (⌘⇧M): the window glides to the corner and back. The corner it heads for moves on a smooth spring;
its size on a bouncier one, so it squeezes past the mini size and swells back (or swells past full size and settles),
like a bubble. The page folds its sidebar and panel on the smooth curve (--mini-ease in app.js) while this runs."""
from __future__ import annotations

import math
import time

LENGTH = 0.9                       # seconds, until it has settled
SMOOTH = (0.85, 11.0)              # damping and stiffness of the corner (app.js springCurve uses the same)
BUBBLE = (0.6, 12.0)               # of the size: about 10% past, then back
_timer = None


def spring(t: float, zeta: float, w0: float) -> float:
    """A damped spring from 0 to 1."""
    wd = w0 * math.sqrt(1 - zeta * zeta)
    return 1 - math.exp(-zeta * w0 * t) * (math.cos(wd * t) + zeta * w0 / wd * math.sin(wd * t))


def run(n, to, done=None) -> None:
    """Main thread. n is the NSWindow, to its final frame."""
    global _timer
    import AppKit
    from Foundation import NSRunLoop, NSTimer
    if _timer:
        _timer.invalidate()
    a = n.frame()
    vis = (n.screen() or AppKit.NSScreen.mainScreen()).visibleFrame()
    # hold the side of the target nearest a screen edge, so the bounce grows away from the edge, not off screen
    right = to.origin.x + to.size.width / 2 > vis.origin.x + vis.size.width / 2
    top = to.origin.y + to.size.height / 2 > vis.origin.y + vis.size.height / 2
    cx = lambda f: f.origin.x + (f.size.width if right else 0)
    cy = lambda f: f.origin.y + (f.size.height if top else 0)
    n.setMinSize_(AppKit.NSSize(120, 120))  # room to squeeze; the caller sets the real minimum when it lands
    mix = lambda x, y, p: x + (y - x) * p
    t0 = time.monotonic()

    def step(timer):
        global _timer
        t = time.monotonic() - t0
        if t >= LENGTH:
            timer.invalidate()
            _timer = None
            n.setFrame_display_(to, True)
            done and done()
            return
        pc, ps = spring(t, *SMOOTH), spring(t, *BUBBLE)
        w, h = mix(a.size.width, to.size.width, ps), mix(a.size.height, to.size.height, ps)
        x, y = mix(cx(a), cx(to), pc), mix(cy(a), cy(to), pc)
        n.setFrame_display_(AppKit.NSMakeRect(x - w if right else x, y - h if top else y, w, h), True)

    _timer = NSTimer.timerWithTimeInterval_repeats_block_(1 / 120, True, step)
    NSRunLoop.currentRunLoop().addTimer_forMode_(_timer, AppKit.NSRunLoopCommonModes)
