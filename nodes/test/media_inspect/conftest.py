"""Make this contribution importable under the engine's pytest interpreter."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))
