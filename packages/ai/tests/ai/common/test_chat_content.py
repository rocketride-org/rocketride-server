"""Unit tests for ``chat._flatten_content``.

Pins the fix for the agent crash on Anthropic (and LangChain v1) responses: those
providers return ``content`` as a list of typed blocks, not a ``str``. The non-streaming
path returned that list verbatim, so ``expectJson`` agent calls hit ``parseJson(list)`` →
``.strip()`` and crashed (``'list' object has no attribute 'strip'``), while other agents
surfaced the raw blocks (leaking internal ``thinking`` text and Anthropic ``signature``
values into the answer). ``_flatten_content`` normalizes any content shape to plain answer
text, keeping only ``text`` blocks and dropping ``thinking`` / ``reasoning`` blocks.

Loaded by file path with chat.py's engine/sibling imports stubbed so no engine runtime is
needed — run with ``pytest --noconftest``.
"""

from __future__ import annotations

import contextvars
import importlib.util
import sys
import types
from pathlib import Path

_CHAT_PATH = Path(__file__).resolve().parents[3] / 'src' / 'ai' / 'common' / 'chat.py'


def _load_flatten_content():
    """Load chat.py by path with its engine/sibling imports stubbed."""
    stub_names = (
        'rocketlib',
        'ai',
        'ai.common',
        'ai.common.schema',
        'ai.common.config',
        'ai.common.util',
        'ai.common.validation',
        'ai.common.llm_native_stream',
    )
    saved = {k: sys.modules.get(k) for k in stub_names}

    rl = types.ModuleType('rocketlib')
    rl.debug = lambda *a, **k: None
    rl.warning = lambda *a, **k: None

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = []

    schema = types.ModuleType('ai.common.schema')
    schema.Answer = type('Answer', (), {})
    schema.Question = type('Question', (), {})

    config = types.ModuleType('ai.common.config')
    config.Config = type('Config', (), {})

    util = types.ModuleType('ai.common.util')
    util.parseJson = lambda value: value

    validation = types.ModuleType('ai.common.validation')
    validation.validate_model_name = lambda *a, **k: None
    validation.validate_max_tokens = lambda *a, **k: None
    validation.validate_prompt = lambda prompt, *a, **k: prompt

    native = types.ModuleType('ai.common.llm_native_stream')
    native.STOP_SEQUENCES_VAR = contextvars.ContextVar('STOP_SEQUENCES_VAR', default=None)
    native.dispatch_native_chat_stream = lambda *a, **k: None

    sys.modules.update(
        {
            'rocketlib': rl,
            'ai': ai_pkg,
            'ai.common': common_pkg,
            'ai.common.schema': schema,
            'ai.common.config': config,
            'ai.common.util': util,
            'ai.common.validation': validation,
            'ai.common.llm_native_stream': native,
        }
    )

    try:
        spec = importlib.util.spec_from_file_location('rr_chat_undertest', _CHAT_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod._flatten_content
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v


_flatten_content = _load_flatten_content()


class TestFlattenContent:
    def test_plain_string_passthrough(self):
        assert _flatten_content('hello world') == 'hello world'

    def test_none_returns_empty_string(self):
        assert _flatten_content(None) == ''

    def test_anthropic_blocks_keep_only_text(self):
        # The exact shape that crashed the agent: a thinking block + a text block.
        content = [
            {'type': 'thinking', 'thinking': 'internal reasoning', 'signature': 'ErQC...'},
            {'type': 'text', 'text': 'Hello!'},
        ]
        assert _flatten_content(content) == 'Hello!'

    def test_thinking_and_signature_never_leak(self):
        out = _flatten_content(
            [
                {'type': 'thinking', 'thinking': 'do not leak me', 'signature': 'sig'},
                {'type': 'text', 'text': 'visible answer'},
            ]
        )
        assert 'do not leak me' not in out
        assert 'sig' not in out

    def test_reasoning_block_dropped(self):
        content = [
            {'type': 'text', 'text': 'A'},
            {'type': 'reasoning', 'reasoning': 'chain of thought'},
            {'type': 'text', 'text': 'B'},
        ]
        assert _flatten_content(content) == 'AB'

    def test_bare_string_blocks_joined(self):
        assert _flatten_content(['foo', 'bar']) == 'foobar'

    def test_result_is_always_a_stripable_string(self):
        # The original bug was parseJson calling .strip() on a list. Whatever the shape,
        # the result must be a str so downstream .strip()/parse never raises.
        for content in ('x', None, [{'type': 'text', 'text': 'y'}], [{'type': 'thinking', 'thinking': 'z'}], 123):
            result = _flatten_content(content)
            assert isinstance(result, str)
            result.strip()  # must not raise
