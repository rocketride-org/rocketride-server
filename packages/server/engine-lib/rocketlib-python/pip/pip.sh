#!/bin/sh
SCRIPT_DIR="$(dirname "$0")"
# Windows: lib/depends.py; Linux/macOS: lib/python3.10/depends.py
DEPENDS="$SCRIPT_DIR/lib/depends.py"
[ -f "$DEPENDS" ] || DEPENDS="$SCRIPT_DIR/lib/python3.10/depends.py"
"$SCRIPT_DIR/engine" "$DEPENDS" "$@"
