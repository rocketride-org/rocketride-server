# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Unit tests for tool_tavily_search pure helpers (no network)."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Bootstrap: inject lightweight stubs so the module can be imported without
# the full engine runtime (pydantic, engLib, etc.).
# ---------------------------------------------------------------------------

# Stub out rocketlib — the unit-tests only exercise pure helper functions
# (_shape_results, _validate_public_url) that live at module level and have no
# dependency on the engine runtime.
_rocketlib_stub = MagicMock()
_rocketlib_stub.IInstanceBase = object  # must be a real class for inheritance
_rocketlib_stub.IGlobalBase = object
_rocketlib_stub.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
_rocketlib_stub.debug = lambda *a, **kw: None
_rocketlib_stub.error = lambda *a, **kw: None
_rocketlib_stub.warning = lambda *a, **kw: None
_rocketlib_stub.OPEN_MODE = MagicMock()
sys.modules.setdefault('rocketlib', _rocketlib_stub)

# Stub depends (used by nodes/__init__.py and ai/__init__.py)
_depends_stub = MagicMock()
_depends_stub.depends = lambda *a, **kw: None
sys.modules.setdefault('depends', _depends_stub)

# Stub ai.common.utils — normalize_tool_input is called inside the tool method,
# not in the helper functions under test, so a trivial pass-through is enough.
_ai_common_utils_stub = MagicMock()
_ai_common_utils_stub.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
sys.modules.setdefault('ai', MagicMock())
sys.modules.setdefault('ai.common', MagicMock())
sys.modules.setdefault('ai.common.utils', _ai_common_utils_stub)
sys.modules.setdefault('ai.common.config', MagicMock())

# Stub out requests — the unit tests exercise pure helpers that do no I/O.
_requests_stub = MagicMock()
_requests_exceptions_stub = MagicMock()
_requests_exceptions_stub.Timeout = TimeoutError
_requests_exceptions_stub.RequestException = Exception
_requests_stub.exceptions = _requests_exceptions_stub
sys.modules.setdefault('requests', _requests_stub)

# Add nodes/src to sys.path so `nodes.tool_tavily_search.IInstance` is resolvable.
_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

# ---------------------------------------------------------------------------
# Load the module under test
# ---------------------------------------------------------------------------

import importlib

mod = importlib.import_module('nodes.tool_tavily_search.IInstance')


def test_shape_results_maps_tavily_fields():
    body = {'results': [{'title': 'T', 'url': 'https://example.com', 'content': 'snippet', 'score': 0.9}]}
    shaped = mod._shape_results('q', body)
    assert shaped['success'] is True
    assert shaped['query'] == 'q'
    assert shaped['num_results'] == 1
    assert shaped['results'][0]['url'] == 'https://example.com'
    assert shaped['results'][0]['score'] == 0.9
    assert shaped['results'][0]['content'] == 'snippet'
    assert shaped['results'][0]['published_date'] is None


def test_validate_public_url_rejects_loopback():
    import pytest

    with pytest.raises(ValueError):
        mod._validate_public_url('http://127.0.0.1/secret')


def test_validate_public_url_allows_public_https(monkeypatch):
    import socket

    monkeypatch.setattr(
        socket,
        'getaddrinfo',
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('93.184.216.34', 0))],
    )
    assert mod._validate_public_url('https://example.com/page') == 'https://example.com/page'
