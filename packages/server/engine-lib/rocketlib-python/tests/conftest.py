"""Make ``lib/`` importable so ``import depends`` works outside the packaged engine."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
