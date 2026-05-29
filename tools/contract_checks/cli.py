"""
Thin CLI entry point for local debugging.

Invoke as:  engine tools/contract_checks/cli.py [--tree=...] [--package=...]

Adjusts sys.path so the engine can locate the ``contract_checks`` package,
then delegates to :mod:`contract_checks.cli`.
"""

from __future__ import annotations

import sys
from pathlib import Path

_SRC = Path(__file__).resolve().parent / 'src'
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from contract_checks.cli import main  # noqa: E402

if __name__ == '__main__':
    sys.exit(main())
