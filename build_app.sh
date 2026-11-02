#!/bin/zsh
# Builds "Tether.app" in ~/Applications. The app runs the code and virtualenv in this folder,
# so re-run this script if you move the folder.
set -euo pipefail
DIR="${0:A:h}"
APP="${APP_PATH:-$HOME/Applications/Tether.app}"

if [[ ! -x "$DIR/.venv/bin/python" ]]; then
  if command -v uv >/dev/null; then
    uv venv -q "$DIR/.venv" --python 3.12
    uv pip install -q --python "$DIR/.venv/bin/python" -r "$DIR/requirements.txt"
  else
    PY=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3)
    "$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || { echo "Tether needs Python 3.11 or newer (or uv: https://docs.astral.sh/uv/)"; exit 1; }
    "$PY" -m venv "$DIR/.venv"
    "$DIR/.venv/bin/pip" install -q -r "$DIR/requirements.txt"
  fi
elif command -v uv >/dev/null; then  # already set up: add any package added since
  uv pip install -q --python "$DIR/.venv/bin/python" -r "$DIR/requirements.txt" || true
else
  "$DIR/.venv/bin/python" -m pip install -q -r "$DIR/requirements.txt" || true
fi
command -v claude >/dev/null || [[ -x "$HOME/.local/bin/claude" || -x "$HOME/.claude/local/claude" ]] || echo "Note: Claude Code isn't installed yet. Get it from https://claude.com/claude-code, then open Tether."

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
[[ -f "$DIR/assets/icon.icns" ]] && cp "$DIR/assets/icon.icns" "$APP/Contents/Resources/icon.icns"
RUN_PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Python itself is the app's program, so macOS shows Tether's name and logo on its notifications and sends a click
# back to the right chat. It's a copy of the Python the virtualenv uses; boot/sitecustomize.py starts Tether.
PY_BIN=$("$DIR/.venv/bin/python" -c 'import os, sys
p = os.path.realpath(sys._base_executable)
a = os.path.join(os.path.dirname(p), "..", "Resources", "Python.app", "Contents", "MacOS", "Python")
print(os.path.realpath(a) if os.path.exists(a) else p)')
PY_HOME=$("$DIR/.venv/bin/python" -c 'import sys; print(sys.base_prefix)')
ENV_PLIST=""
if cp "$PY_BIN" "$APP/Contents/MacOS/Tether" 2>/dev/null &&
   PYTHONHOME="$PY_HOME" PYTHONPATH= "$APP/Contents/MacOS/Tether" -c 'import encodings' >/dev/null 2>&1; then
  ENV_PLIST="  <key>LSEnvironment</key><dict>
    <key>PATH</key><string>$RUN_PATH</string>
    <key>PYTHONHOME</key><string>$PY_HOME</string>
    <key>PYTHONPATH</key><string>$DIR/boot</string>
    <key>TETHER_BOOT</key><string>$DIR/workbench.py</string>
    <key>TETHER_VENV</key><string>$DIR/.venv</string>
    <key>TETHER_APP</key><string>$APP</string>
  </dict>"
else  # that Python can't run from inside the app: a small script starts it instead (notifications via AppleScript)
  cat > "$APP/Contents/MacOS/Tether" <<LAUNCH
#!/bin/zsh
export PATH="$RUN_PATH"
export TETHER_APP="$APP"
cd "$DIR"
exec "$DIR/.venv/bin/python" "$DIR/workbench.py" 2>>"\$HOME/Library/Logs/Tether.log"
LAUNCH
  chmod +x "$APP/Contents/MacOS/Tether"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Tether</string>
  <key>CFBundleDisplayName</key><string>Tether</string>
  <key>CFBundleIdentifier</key><string>local.tether</string>
  <key>CFBundleExecutable</key><string>Tether</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>Tether transcribes your voice on this Mac. Audio isn't kept or sent anywhere.</string>
$ENV_PLIST
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
# macOS keeps its own copy of the app's settings: refresh it so the new ones apply
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Built: $APP"
