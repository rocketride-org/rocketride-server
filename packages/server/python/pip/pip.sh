#!/bin/sh
SCRIPT_DIR="$(dirname "$0")"
# Windows: lib/depends.py; Linux/macOS: lib/python3.12/depends.py
DEPENDS="$SCRIPT_DIR/lib/depends.py"
[ -f "$DEPENDS" ] || DEPENDS="$SCRIPT_DIR/lib/python3.12/depends.py"
"$SCRIPT_DIR/engine" "$DEPENDS" "$@"
