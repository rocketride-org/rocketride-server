# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Mock external dependencies so audio_tts modules can be imported without
the full RocketRide server or heavy ML libraries.

Skipped by default — audio_tts is in the ``skip_nodes`` set.  Opt-in with::

    ROCKETRIDE_INCLUDE_SKIP=audio_tts pytest nodes/test/audio_tts/ -v
"""

import os
import sys
from pathlib import Path
from types import ModuleType
from unittest.mock import MagicMock

import pytest


def _stub_module(name, **attrs):
    """Register a stub module in ``sys.modules`` if not already present."""
    if name in sys.modules:
        return sys.modules[name]
    mod = ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    sys.modules[name] = mod
    return mod


# -- rocketlib ---------------------------------------------------------------


class _IGlobalBase:
    """Minimal stand-in for ``rocketlib.IGlobalBase``."""

    pass


class _IInstanceBase:
    """Minimal stand-in for ``rocketlib.IInstanceBase``."""

    pass


class _OPEN_MODE:
    CONFIG = 'CONFIG'
    NORMAL = 'NORMAL'


class _AVI_ACTION:
    BEGIN = 'BEGIN'
    WRITE = 'WRITE'
    END = 'END'


_stub_module(
    'rocketlib',
    IGlobalBase=_IGlobalBase,
    IInstanceBase=_IInstanceBase,
    OPEN_MODE=_OPEN_MODE,
    AVI_ACTION=_AVI_ACTION,
    warning=lambda msg: None,
)

# -- ai.common tree ----------------------------------------------------------

_stub_module('ai')
_stub_module('ai.common')
_stub_module('ai.common.config', Config=MagicMock())
_stub_module('ai.common.models')
_stub_module(
    'ai.common.models.base',
    get_model_server_address=MagicMock(return_value=None),
    ModelClient=MagicMock(),
)
_stub_module('ai.common.models.audio')
_stub_module(
    'ai.common.models.audio.piper_native',
    load_piper_voice=MagicMock(),
    write_piper_wav=MagicMock(),
)
_stub_module(
    'ai.common.models.audio.wav_to_mp3',
    wav_to_mp3_lameenc=MagicMock(),
)
_stub_module(
    'ai.common.models.audio.piper_hub',
    ensure_piper_voice_cached=MagicMock(return_value='/tmp/fake.onnx'),
)
_stub_module(
    'ai.common.models.audio.spacy_en_model',
    ensure_spacy_en_model=MagicMock(),
)
_stub_module('ai.common.models.transformers', pipeline=MagicMock())

# -- depends (pip installer) -------------------------------------------------

_stub_module('depends', depends=MagicMock())

# -- numpy / requests (heavy deps, stub only when not installed) -------------

try:
    import numpy  # noqa: F401 – real package available
except ImportError:
    _np = _stub_module('numpy')
    _np.ndarray = type('ndarray', (), {})
    _np.float32 = 'float32'
    _np.int16 = 'int16'
    _np.array = MagicMock(return_value=MagicMock(size=0, ndim=1))
    _np.asarray = MagicMock(return_value=MagicMock(size=0, ndim=1))
    _np.clip = lambda a, lo, hi: a
    _np.concatenate = MagicMock()

try:
    import requests  # noqa: F401
except ImportError:
    _stub_module('requests')

# -- Add nodes source to import path ----------------------------------------

NODES_SRC = Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes'
if str(NODES_SRC) not in sys.path:
    sys.path.insert(0, str(NODES_SRC))


# -- Test helper: detect real numpy ------------------------------------------


def _has_real_numpy():
    """Return True when the real numpy package (not our stub) is available."""
    try:
        import numpy as np

        return hasattr(np, 'testing')
    except Exception:
        return False


HAS_NUMPY = _has_real_numpy()


# -- Gate: honour the skip_nodes convention ----------------------------------


def pytest_collection_modifyitems(config, items):
    """Skip all audio_tts unit tests unless the node is opted-in via
    ``ROCKETRIDE_INCLUDE_SKIP``, matching the same ``skip_nodes`` gate used
    by the dynamic test framework in ``nodes/test/conftest.py``.
    """
    include_skip = {n.strip() for n in os.environ.get('ROCKETRIDE_INCLUDE_SKIP', '').split(',') if n.strip()}
    if 'audio_tts' in include_skip:
        return
    marker = pytest.mark.skip(
        reason='audio_tts is in skip_nodes; opt-in with ROCKETRIDE_INCLUDE_SKIP=audio_tts',
    )
    for item in items:
        item.add_marker(marker)
