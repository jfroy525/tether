"""Starts Tether when Tether.app runs Python as its own program. That way macOS shows Tether's name and logo on its
notifications and sends their clicks back here. build_app.sh points Python at this folder through the app's
Info.plist. Any other Python that finds this file does nothing."""
import os
import sys

_boot = os.environ.pop("TETHER_BOOT", "")
if _boot and all(a in ("", "-") or a.startswith("-psn") for a in sys.argv):
    for _k in ("PYTHONHOME", "PYTHONPATH"):  # Claude's own commands must not inherit these
        os.environ.pop(_k, None)
    import atexit, glob, runpy, site, traceback
    _venv = os.environ.get("TETHER_VENV", "")
    for _p in sorted(glob.glob(os.path.join(_venv, "lib", "python*", "site-packages"))):
        site.addsitedir(_p)
    if os.path.exists(os.path.join(_venv, "bin", "python")):
        sys.executable = os.path.join(_venv, "bin", "python")  # helpers Tether starts use the normal Python
    try:
        _fd = os.open(os.path.expanduser("~/Library/Logs/Tether.log"), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        os.dup2(_fd, 2)
    except OSError:
        pass
    os.chdir(os.path.dirname(_boot))
    sys.path.insert(0, os.path.dirname(_boot))  # as `python workbench.py` would
    sys.argv = [_boot]
    _code = 0
    try:
        runpy.run_path(_boot, run_name="__main__")
    except SystemExit as e:
        _code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException:  # noqa: BLE001
        traceback.print_exc()
        _code = 1
    atexit._run_exitfuncs()
    sys.stdout.flush(); sys.stderr.flush()
    os._exit(_code)  # leaving here would carry on into an interactive Python
