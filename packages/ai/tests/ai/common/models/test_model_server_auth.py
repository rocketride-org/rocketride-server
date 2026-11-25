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
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import rocketride.core.transport_websocket as transport_module
from ai.common.models.base import ModelClient
from ai.common.models.transformers.sentence_transformers import SentenceTransformerLoader
from ai.common.models.transformers.transformers import TransformersLoader
from ai.modules.task.task_engine import filter_subprocess_env


class _FakeSocket:
    """A connected socket whose recv() waits until it is closed."""

    def __init__(self):
        self._closed = asyncio.Event()

    async def recv(self):
        await self._closed.wait()
        raise ConnectionError('closed')

    async def close(self):
        self._closed.set()


def _handshake_headers(monkeypatch, token):
    """Open a ModelClient's socket and return the headers its handshake carried."""
    if token is None:
        monkeypatch.delenv('RR_MODEL_SERVER_AUTH_TOKEN', raising=False)
    else:
        monkeypatch.setenv('RR_MODEL_SERVER_AUTH_TOKEN', token)
    connect = AsyncMock(side_effect=lambda *a, **k: _FakeSocket())
    monkeypatch.setattr(transport_module, 'websockets', SimpleNamespace(__version__='16.0', connect=connect))

    client = ModelClient('localhost:5590')

    async def attach_and_close():
        await client.attach()
        await client.detach()

    asyncio.run(attach_and_close())
    return connect.call_args.kwargs.get('additional_headers')


def test_model_client_sends_the_token_on_the_handshake(monkeypatch):
    assert _handshake_headers(monkeypatch, 's3cret') == {'Authorization': 'Bearer s3cret'}


def test_model_client_without_a_token_sends_no_header(monkeypatch):
    assert _handshake_headers(monkeypatch, None) is None


def test_task_processes_inherit_the_token():
    assert filter_subprocess_env({'RR_MODEL_SERVER_AUTH_TOKEN': 't'}) == {'RR_MODEL_SERVER_AUTH_TOKEN': 't'}


@pytest.fixture
def captured_hf_kwargs(monkeypatch):
    """Stub the Hugging Face constructors and record the kwargs each load passes."""
    seen = {}

    class _Model:
        config = None

        def __init__(self, *args, **kwargs):
            seen.update(kwargs)

        @classmethod
        def from_pretrained(cls, *args, **kwargs):
            return cls(**kwargs)

        def eval(self):
            return self

        def to(self, device):
            return self

    monkeypatch.setitem(sys.modules, 'sentence_transformers', types.SimpleNamespace(SentenceTransformer=_Model))
    monkeypatch.setitem(sys.modules, 'transformers', types.SimpleNamespace(AutoModel=_Model))
    for loader in (SentenceTransformerLoader, TransformersLoader):
        monkeypatch.setattr(loader, '_ensure_dependencies', staticmethod(lambda: None))
        monkeypatch.setattr(loader, '_get_memory_footprint', staticmethod(lambda model: 0.0))
    monkeypatch.setattr(TransformersLoader, '_load_tokenizer', staticmethod(lambda name: None))
    return seen


@pytest.mark.parametrize('loader', [SentenceTransformerLoader, TransformersLoader])
def test_loaders_do_not_trust_remote_code_by_default(captured_hf_kwargs, loader):
    try:
        loader.load('org/model', device='cpu')
    except Exception:
        pass  # only the kwargs handed to the constructor matter here
    assert captured_hf_kwargs.get('trust_remote_code') is False
