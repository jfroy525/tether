"""
No longer used: permission modes now behave exactly as in the CLI. Kept only because sessions started before that
change still call this hook until they restart; it does nothing. Safe to delete once every session has restarted.
The old always-ask version is in guard.py.bak-pre-cli-modes.
"""
