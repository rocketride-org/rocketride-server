"""
Thin CLI entry point for local debugging.

Invoke as:  python tools/docs_audit/cli.py [--root=...] [--json]

Adjusts sys.path so the ``docs_audit`` package is importable, then delegates
to :mod:`docs_audit.cli`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent / 'src'
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from docs_audit.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
