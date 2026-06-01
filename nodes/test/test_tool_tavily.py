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

"""Unit tests for tool_tavily pure helpers (no network)."""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

# ---------------------------------------------------------------------------
# Bootstrap: when run under a bare interpreter that lacks the engine runtime
# (rocketlib, ai.common, requests), inject lightweight stubs ONLY for modules
# that are not already present, import the module under test, then REMOVE the
# stubs we added. Restoring is essential: under the full `builder nodes:test-full`
# run these modules are real and shared across the whole pytest session, so a
# leaked MagicMock stub would break unrelated nodes' tests (e.g. tool_git,
# tool_filesystem, which rely on the real rocketlib schema helpers). The pure
# helpers under test (_shape_results, _validate_public_url) hold no runtime
# dependency on the stubbed modules, so dropping the stubs after import is safe.
# ---------------------------------------------------------------------------

import importlib

# Add nodes/src to sys.path so `nodes.tool_tavily.IInstance` is resolvable.
_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the module."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object  # must be a real class for inheritance
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = MagicMock()

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}

    requests = MagicMock()
    requests.exceptions = MagicMock()
    requests.exceptions.Timeout = TimeoutError
    requests.exceptions.RequestException = Exception

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
        'requests': requests,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

mod = importlib.import_module('nodes.tool_tavily.IInstance')

# Drop the stubs we injected so they never leak into the shared pytest session.
for _name in _added_stubs:
    sys.modules.pop(_name, None)


def test_shape_results_maps_tavily_fields(monkeypatch):
    import socket

    # _shape_results validates each URL via _validate_public_url -> socket.getaddrinfo;
    # stub DNS so the test stays network-independent (offline CI safe).
    monkeypatch.setattr(
        socket,
        'getaddrinfo',
        lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('93.184.216.34', 0))],
    )
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
