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

"""HTTP ``POST /pipe/validate``: the pipeline envelope is unwrapped before use."""

from unittest.mock import MagicMock

import pytest

from ai.modules.pipe import pipe_validate as mod

_FLAT = {'components': [{'id': 'webhook_1', 'config': {'mode': 'Source'}}], 'version': 1}


@pytest.fixture
def captured(monkeypatch):
    """Capture the payload that would reach the engine."""
    seen = {}
    monkeypatch.setattr(mod, 'validatePipeline', lambda payload: seen.update(payload) or {'ok': True})
    monkeypatch.setattr(mod, 'response', lambda data: data)
    monkeypatch.setattr(mod, 'exception', lambda e: {'error': str(e)})
    return seen


@pytest.mark.asyncio
async def test_a_flat_config_is_wrapped_once(captured):
    await mod.pipe_Validate(MagicMock(), dict(_FLAT))

    assert set(captured.keys()) == {'pipeline'}
    assert captured['pipeline']['components'] == _FLAT['components']


@pytest.mark.asyncio
async def test_an_enveloped_config_is_not_wrapped_twice(captured):
    """An enveloped config reaches the engine under exactly one envelope."""
    await mod.pipe_Validate(MagicMock(), {'pipeline': dict(_FLAT)})

    assert set(captured.keys()) == {'pipeline'}
    assert 'pipeline' not in captured['pipeline']
    assert captured['pipeline']['components'] == _FLAT['components']


@pytest.mark.asyncio
async def test_the_source_is_inferred_through_the_envelope(captured):
    """The source walk reads the components of an enveloped config."""
    await mod.pipe_Validate(MagicMock(), {'pipeline': dict(_FLAT)})

    assert captured['pipeline']['source'] == 'webhook_1'


@pytest.mark.asyncio
async def test_an_explicit_source_still_wins(captured):
    await mod.pipe_Validate(MagicMock(), dict(_FLAT), source='chat_1')

    assert captured['pipeline']['source'] == 'chat_1'
