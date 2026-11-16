"""Put ``lib/`` ahead of ``dist`` on ``sys.path`` so ``import depends`` reads the source tree."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
