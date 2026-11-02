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
fi
command -v claude >/dev/null || [[ -x "$HOME/.local/bin/claude" || -x "$HOME/.claude/local/claude" ]] || echo "Note: Claude Code isn't installed yet. Get it from https://claude.com/claude-code, then open Tether."

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
[[ -f "$DIR/assets/icon.icns" ]] && cp "$DIR/assets/icon.icns" "$APP/Contents/Resources/icon.icns"

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
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/Tether" <<LAUNCH
#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:\$HOME/.local/bin:\$PATH"
cd "$DIR"
exec "$DIR/.venv/bin/python" "$DIR/workbench.py" 2>>"\$HOME/Library/Logs/Tether.log"
LAUNCH
chmod +x "$APP/Contents/MacOS/Tether"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
echo "Built: $APP"
