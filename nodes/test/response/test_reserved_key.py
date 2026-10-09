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

"""The response node rejects 'decisions' as a custom key (spec §8)."""

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

response_global = importlib.import_module('response.IGlobal')  # noqa: E402


def _glb(conn):
    glb = response_global.IGlobal()
    glb.glb = SimpleNamespace(connConfig=conn)
    return glb


@pytest.mark.parametrize(
    'conn',
    [{'laneName': 'decisions'}, {'lanes': [{'laneId': 'text', 'laneName': 'decisions'}]}],
)
def test_decisions_key_is_rejected(conn):
    with pytest.raises(ValueError, match="'decisions' is reserved for decision nodes"):
        _glb(conn).beginGlobal()


def test_validate_config_warns(monkeypatch):
    warnings = []
    monkeypatch.setattr(response_global, 'warning', warnings.append)
    _glb({'laneName': 'decisions'}).validateConfig()
    assert warnings == ["'decisions' is reserved for decision nodes"]


def test_other_keys_still_work():
    glb = _glb({'lanes': [{'laneId': 'text', 'laneName': 'body'}]})
    glb.beginGlobal()
    assert glb.lanes == {'text': 'body'}
