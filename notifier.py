"""Mac notifications. When Tether.app runs Python as its own program (see build_app.sh), they come from Tether: its
name and logo, and a click opens that chat. Otherwise they go through AppleScript, which macOS files under Script
Editor (a click opens Script Editor)."""
from __future__ import annotations

import json
import subprocess

_center = None
_delegate = None  # macOS holds it weakly: kept here, or clicks go nowhere
_on_click = None
_asked = False

try:
    import objc
    import UserNotifications as UN
    from Foundation import NSObject

    class _Delegate(NSObject, protocols=[objc.protocolNamed("UNUserNotificationCenterDelegate")]):
        # macOS calls these on its own threads. They must return nothing, and an error here would end the app.
        def userNotificationCenter_willPresentNotification_withCompletionHandler_(self, center, note, done):
            try:
                done(UN.UNNotificationPresentationOptionBanner | UN.UNNotificationPresentationOptionList)
            except Exception:  # noqa: BLE001
                pass

        def userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler_(self, center, resp, done):
            try:
                sid = str((resp.notification().request().content().userInfo() or {}).get("sid") or "")
                if _on_click and sid:
                    _on_click(sid)
            except Exception:  # noqa: BLE001
                pass
            try:
                done()
            except Exception:  # noqa: BLE001
                pass
except Exception:  # noqa: BLE001  (the package isn't installed yet: AppleScript it is)
    UN = None


def setup(on_click) -> None:
    """Asks macOS once for permission (it remembers the answer). Only works when Python is Tether.app's own program."""
    global _center, _delegate, _on_click, _asked
    _on_click, _asked = on_click, True
    if UN is None:
        return
    try:
        from Foundation import NSBundle
        b = NSBundle.mainBundle()
        if not str(b.bundlePath()).endswith(".app") or not b.bundleIdentifier():
            return
        _center = UN.UNUserNotificationCenter.currentNotificationCenter()
        _delegate = _Delegate.alloc().init()
        _center.setDelegate_(_delegate)
        _center.requestAuthorizationWithOptions_completionHandler_(UN.UNAuthorizationOptionAlert, _answered)
    except Exception:  # noqa: BLE001
        _center = None


def asked() -> bool:
    return _asked


def _answered(ok, err) -> None:
    pass  # if they're off in System Settings, Tether stays quiet (Settings › Notifications says so)


def _added(err) -> None:
    pass


def turned_off() -> bool:
    """True when macOS has Tether's notifications switched off (System Settings › Notifications)."""
    if _center is None:
        return False
    import threading
    got, out = threading.Event(), {}

    def seen(settings) -> None:
        try:
            out["status"] = settings.authorizationStatus()
        except Exception:  # noqa: BLE001
            pass
        got.set()
    try:
        _center.getNotificationSettingsWithCompletionHandler_(seen)
    except Exception:  # noqa: BLE001
        return False
    got.wait(1.5)
    return out.get("status") == UN.UNAuthorizationStatusDenied


def post(sid: str, title: str, text: str) -> None:
    if _center is not None:
        try:
            c = UN.UNMutableNotificationContent.alloc().init()
            c.setTitle_(title[:80])
            c.setBody_(text[:180])
            c.setUserInfo_({"sid": sid})
            c.setThreadIdentifier_(sid)
            # one per chat: a newer one replaces the last ("Needs your approval", then "Finished")
            req = UN.UNNotificationRequest.requestWithIdentifier_content_trigger_(sid or "tether", c, None)
            _center.addNotificationRequest_withCompletionHandler_(req, _added)
            return
        except Exception:  # noqa: BLE001
            pass
    script = f"display notification {json.dumps(text[:180])} with title {json.dumps(title[:80])}"
    subprocess.Popen(["osascript", "-e", script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
