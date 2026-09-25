"""Put ``lib/`` ahead of ``dist`` on ``sys.path`` so ``import depends`` reads the source tree."""

import sys
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))

# engLib is compiled into engine.exe and does not exist outside it, yet every
# rocketlib import needs it. Stub it only when it is genuinely unavailable.
try:
    import engLib  # noqa: F401
except ImportError:
    sys.modules['engLib'] = MagicMock()

# Importing rocketlib runs depends(), which bootstraps pip/uv into a cache dir beside
# the Python install — admin-only on Windows, so it fails here. Stub it for that one
# import, then hand the name straight back: test_depends.py tests the real module.
# Done in conftest so it happens before any test module, whatever the collection order.
_depends_stub = MagicMock()
_depends_stub.depends = lambda *args, **kwargs: None
_real_depends = sys.modules.get('depends')
sys.modules['depends'] = _depends_stub
try:
    import rocketlib  # noqa: F401
finally:
    if _real_depends is not None:
        sys.modules['depends'] = _real_depends
    else:
        sys.modules.pop('depends', None)
