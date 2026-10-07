# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A Bedrock chat no longer depends on the transformers package to count tokens.

ChatBase counts a prompt's tokens before every call (for its size warnings), and
the same getTokens is what an LLM node hands to nodes that cut documents to fit the
model (getTokenCounter: summarization, preprocessor_llm). The node left the count
to LangChain, which uses the GPT-2 tokenizer from the transformers package, and
neither the engine nor the node installs it. On an engine where no other node had
installed it, every Bedrock chat failed with "Could not import transformers python
package" before it was sent.

These tests run the real node driver and the real langchain-aws client with
LangChain's GPT-2 tokenizer made unavailable, so they fail on the old driver
whatever is installed and whatever ran before them. No key or network is used.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

pytest.importorskip('langchain_aws')

from ai.common.config import Config  # noqa: E402

_MOD_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'nodes', 'llm_bedrock', 'bedrock.py'
)


class _InvokeModel(BaseHTTPRequestHandler):
    """Answers bedrock-runtime's InvokeModel the way Bedrock does for Claude."""

    calls = 0

    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length') or 0))
        _InvokeModel.calls += 1
        data = json.dumps(
            {
                'id': 'msg_1',
                'type': 'message',
                'role': 'assistant',
                'content': [{'type': 'text', 'text': 'Hello.'}],
                'stop_reason': 'end_turn',
                'usage': {'input_tokens': 3, 'output_tokens': 2},
            }
        ).encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture
def no_transformers(monkeypatch):
    """Make the GPT-2 tokenizer unavailable, as on an engine that never installed transformers.

    Blocking the import is not enough on its own: LangChain caches the import and the
    tokenizer after their first use, so a count earlier in the same run would get past it.
    """
    from langchain_core.language_models import base as langchain_base

    def unavailable():
        raise ImportError('Could not import transformers python package.')

    monkeypatch.setitem(sys.modules, 'transformers', None)
    monkeypatch.setattr(langchain_base, 'get_tokenizer', unavailable)


@pytest.fixture
def bedrock(monkeypatch):
    _InvokeModel.calls = 0
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), _InvokeModel)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    monkeypatch.setenv('AWS_ENDPOINT_URL_BEDROCK_RUNTIME', f'http://127.0.0.1:{httpd.server_address[1]}')
    yield _InvokeModel
    httpd.shutdown()


def _chat(monkeypatch, model: str):
    config = {
        'model': model,
        'accessKey': 'AKIDEXAMPLE',
        'secretKey': 'secret-example',
        'region': 'us-east-1',
        'modelTotalTokens': 200000,
        'modelOutputTokens': 8192,
    }
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda *a, **k: dict(config)))
    spec = importlib.util.spec_from_file_location('_llm_bedrock_token_test', _MOD_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Chat('bedrock', {}, {})


def test_a_claude_chat_is_sent_without_transformers(monkeypatch, no_transformers, bedrock):
    """Before: ImportError from the token count, and the request never left."""
    chat = _chat(monkeypatch, 'anthropic.claude-sonnet-4-5-20250929-v1:0')

    answer = chat.chat_string('Say hello.')

    assert answer == 'Hello.'
    assert bedrock.calls == 1


@pytest.mark.parametrize(
    'model',
    [
        'anthropic.claude-sonnet-4-5-20250929-v1:0',
        'meta.llama3-3-70b-instruct-v1:0',
        'amazon.nova-2-lite-v1:0',
        'amazon.titan-text-express-v1',
        'cohere.command-r-v1:0',
    ],
)
def test_every_model_family_counts_without_transformers(monkeypatch, no_transformers, model):
    """Claude tries the old anthropic tokenizer first; the others go straight to GPT-2."""
    chat = _chat(monkeypatch, model)

    assert chat.getTokens('word ' * 100) == 125


def test_the_estimate_is_about_four_characters_a_token(monkeypatch, no_transformers):
    chat = _chat(monkeypatch, 'anthropic.claude-sonnet-4-5-20250929-v1:0')

    assert [chat.getTokens(text) for text in ('', 'a', 'abcd', 'abcde', 'x' * 4000)] == [1, 1, 1, 2, 1000]
