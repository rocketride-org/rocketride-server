# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The model client authenticates to the model server, and loaders do not run repository code by default."""

import asyncio
import sys
import types

import pytest

import rocketride.core.transport_websocket as transport_module
from ai.common.models.base import ModelClient
from ai.common.models.transformers.sentence_transformers import SentenceTransformerLoader
from ai.common.models.transformers.transformers import TransformersLoader
from ai.modules.task.task_engine import filter_subprocess_env


class _Captured(Exception):
    """Raised by the stubs once they have recorded what they were called with."""


def _handshake_headers(monkeypatch, token):
    """Return the headers a ModelClient's WebSocket handshake carries."""
    if token is None:
        monkeypatch.delenv('RR_MODEL_SERVER_AUTH_TOKEN', raising=False)
    else:
        monkeypatch.setenv('RR_MODEL_SERVER_AUTH_TOKEN', token)
    seen = {}

    async def connect(*args, **kwargs):
        seen.update(kwargs)
        raise _Captured

    monkeypatch.setattr(transport_module, 'websockets', types.SimpleNamespace(__version__='16.0', connect=connect))
    with pytest.raises(Exception):
        asyncio.run(ModelClient('localhost:5590').attach())
    return seen.get('additional_headers')


def test_model_client_sends_the_token_on_the_handshake(monkeypatch):
    assert _handshake_headers(monkeypatch, 's3cret') == {'Authorization': 'Bearer s3cret'}


def test_model_client_without_a_token_sends_no_header(monkeypatch):
    assert _handshake_headers(monkeypatch, None) is None


def test_task_processes_inherit_the_token():
    assert filter_subprocess_env({'RR_MODEL_SERVER_AUTH_TOKEN': 't'}) == {'RR_MODEL_SERVER_AUTH_TOKEN': 't'}


@pytest.mark.parametrize('loader', [SentenceTransformerLoader, TransformersLoader])
def test_loaders_do_not_trust_remote_code_by_default(monkeypatch, loader):
    seen = {}

    def record(*args, **kwargs):
        seen.update(kwargs)
        raise _Captured

    model = types.SimpleNamespace(from_pretrained=record)
    monkeypatch.setitem(sys.modules, 'sentence_transformers', types.SimpleNamespace(SentenceTransformer=record))
    monkeypatch.setitem(sys.modules, 'transformers', types.SimpleNamespace(AutoModel=model))
    monkeypatch.setattr(loader, '_ensure_dependencies', staticmethod(lambda: None))
    with pytest.raises(_Captured):
        loader.load('org/model', device='cpu')
    assert seen['trust_remote_code'] is False
