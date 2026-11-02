"""
A system-wide speak key, using the classic Carbon hotkey API.

Unlike keyboard monitors, RegisterEventHotKey needs no Accessibility or Input
Monitoring permission, and it reports both press and release, so the key can be
held to talk. Registration must happen on the main (AppKit) thread; callbacks
also arrive there, so keep them quick.
"""

from __future__ import annotations

import ctypes
from typing import Callable, Optional

CMD, SHIFT, OPTION, CONTROL = 0x100, 0x200, 0x800, 0x1000
SPACE, BACKTICK, F13 = 49, 50, 105

# settings value -> (label, key code, modifiers)
HOTKEYS = {
    "off": ("Off", None, 0),
    "alt+space": ("⌥ Space", SPACE, OPTION),
    "ctrl+alt+space": ("⌃⌥ Space", SPACE, CONTROL | OPTION),
    "cmd+shift+space": ("⌘⇧ Space", SPACE, CMD | SHIFT),
    "alt+backtick": ("⌥ `", BACKTICK, OPTION),
    "alt+shift+space": ("⌥⇧ Space", SPACE, OPTION | SHIFT),
    "ctrl+alt+e": ("⌃⌥ E", 14, CONTROL | OPTION),
    "ctrl+alt+c": ("⌃⌥ C", 8, CONTROL | OPTION),
    "ctrl+alt+d": ("⌃⌥ D", 2, CONTROL | OPTION),
    "f13": ("F13", F13, 0),
}

_PRESSED, _RELEASED = 5, 6
_ALREADY_TAKEN = -9878  # eventHotKeyExistsErr


def _fourcc(code: str) -> int:
    return int.from_bytes(code.encode("ascii"), "big")


class _HotKeyID(ctypes.Structure):
    _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]


class _EventTypeSpec(ctypes.Structure):
    _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]


_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)

_carbon = ctypes.CDLL("/System/Library/Frameworks/Carbon.framework/Carbon")
_carbon.GetApplicationEventTarget.restype = ctypes.c_void_p
_carbon.GetEventKind.restype = ctypes.c_uint32
_carbon.GetEventKind.argtypes = [ctypes.c_void_p]
_carbon.InstallEventHandler.restype = ctypes.c_int32
_carbon.InstallEventHandler.argtypes = [ctypes.c_void_p, _HANDLER, ctypes.c_ulong,
                                        ctypes.POINTER(_EventTypeSpec), ctypes.c_void_p,
                                        ctypes.POINTER(ctypes.c_void_p)]
_carbon.RegisterEventHotKey.restype = ctypes.c_int32
_carbon.RegisterEventHotKey.argtypes = [ctypes.c_uint32, ctypes.c_uint32, _HotKeyID, ctypes.c_void_p,
                                        ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
_carbon.GetEventParameter.restype = ctypes.c_int32
_carbon.GetEventParameter.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                      ctypes.c_ulong, ctypes.c_void_p, ctypes.c_void_p]
_NOT_MINE = -9874  # eventNotHandledErr: pass it on to the next handler (another key)
_carbon.UnregisterEventHotKey.restype = ctypes.c_int32
_carbon.UnregisterEventHotKey.argtypes = [ctypes.c_void_p]


class SpeakKey:
    """One global hotkey. Call set() on the main thread to (re)bind it."""

    def __init__(self, on_press: Callable[[], None], on_release: Callable[[], None], key_id: int = 1, name: str = "speak key"):
        self._on_press, self._on_release = on_press, on_release
        self._id, self._name = key_id, name  # each key's handler sees every hotkey, so it checks the id
        self._ref = ctypes.c_void_p()
        self._installed = False
        self._callback = _HANDLER(self._handle)  # keep a reference so it isn't freed

    def _handle(self, _call_ref, event, _user) -> int:
        hk = _HotKeyID()
        if _carbon.GetEventParameter(event, _fourcc("----"), _fourcc("hkid"), None, ctypes.sizeof(hk), None,
                                     ctypes.byref(hk)) == 0 and hk.id != self._id:
            return _NOT_MINE
        kind = _carbon.GetEventKind(event)
        try:
            if kind == _PRESSED:
                self._on_press()
            elif kind == _RELEASED:
                self._on_release()
        except Exception:  # noqa: BLE001 - never let an exception cross into Carbon
            pass
        return 0

    def set(self, key: str) -> Optional[str]:
        """Bind `key` (a HOTKEYS name). Returns an error message, or None when fine."""
        self.clear()
        label, code, mods = HOTKEYS.get(key, HOTKEYS["off"])
        if code is None:
            return None
        target = _carbon.GetApplicationEventTarget()
        if not self._installed:
            specs = (_EventTypeSpec * 2)(_EventTypeSpec(_fourcc("keyb"), _PRESSED),
                                         _EventTypeSpec(_fourcc("keyb"), _RELEASED))
            status = _carbon.InstallEventHandler(target, self._callback, 2, specs, None, None)
            if status != 0:
                return f"Couldn't set up the {self._name} (error {status})."
            self._installed = True
        status = _carbon.RegisterEventHotKey(code, mods, _HotKeyID(_fourcc("CWbk"), self._id), target, 0,
                                             ctypes.byref(self._ref))
        if status == _ALREADY_TAKEN:
            return f"{label} is already used by another app. Pick a different {self._name} in Settings."
        if status != 0:
            return f"Couldn't register {label} (error {status})."
        return None

    def clear(self) -> None:
        if self._ref.value:
            _carbon.UnregisterEventHotKey(self._ref)
            self._ref = ctypes.c_void_p()
