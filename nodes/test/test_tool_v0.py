# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for tool_v0 IInstance (no network).

Covers the v0 Platform API response parsing (_shape_chat) and the
generate_ui / refine_ui tool methods against a mocked post_with_retry,
including the success, API-error ({"error": {...}}), and empty-files cases.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# ---------------------------------------------------------------------------
# Stubs — installed before importing the module under test. The new IInstance
# imports `normalize_tool_input` and `post_with_retry` from `ai.common.utils`
# and `requests`; provide lightweight stand-ins so the module imports and runs
# without the engine runtime or network.
# ---------------------------------------------------------------------------

_WARNING_CALLS: list[str] = []


def _reset_warnings() -> None:
    _WARNING_CALLS.clear()


def _stub_warning(msg: str, *_a: object, **_k: object) -> None:
    _WARNING_CALLS.append(msg)


# Captures the args post_with_retry is called with, and what it should return/raise.
_POST = SimpleNamespace(calls=[], return_body=None, side_effect=None)


def _reset_post() -> None:
    _POST.calls = []
    _POST.return_body = None
    _POST.side_effect = None


def _stub_post_with_retry(url, *, headers=None, json=None, timeout=None, **_kw):
    _POST.calls.append({'url': url, 'headers': headers, 'json': json, 'timeout': timeout})
    if _POST.side_effect is not None:
        raise _POST.side_effect
    resp = MagicMock()
    resp.json.return_value = _POST.return_body
    return resp


def _build_import_stubs() -> dict:
    """Return {module_name: stub} for the deps needed only to import the module."""
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib.warning = _stub_warning
    # Other nodes' IInstance modules import these from rocketlib; include them so
    # a leaked stub (were one to leak) would not be missing attributes. We pop the
    # stub after import regardless, so this is belt-and-suspenders.
    rocketlib.debug = lambda *_a, **_k: None
    rocketlib.error = lambda *_a, **_k: None
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')

    # requests stub with real exception classes so `except` clauses catch them.
    requests = types.ModuleType('requests')
    requests.exceptions = types.SimpleNamespace()
    requests.exceptions.Timeout = TimeoutError
    requests.exceptions.ConnectionError = ConnectionError

    class _RequestException(Exception):
        pass

    class _InvalidJSONError(_RequestException):
        pass

    requests.exceptions.RequestException = _RequestException
    requests.exceptions.InvalidJSONError = _InvalidJSONError
    requests.RequestException = _RequestException

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    ai_utils = types.ModuleType('ai.common.utils')
    ai_utils.normalize_tool_input = lambda args, **_kw: args if isinstance(args, dict) else {}
    ai_utils.post_with_retry = _stub_post_with_retry
    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = MagicMock()

    return {
        'rocketlib': rocketlib,
        'requests': requests,
        'ai': ai_pkg,
        'ai.common': ai_common,
        'ai.common.utils': ai_utils,
        'ai.common.config': ai_config,
    }


# ---------------------------------------------------------------------------
# Load the module under test via importlib so we avoid the package __init__ chain.
#
# Inject stubs ONLY for modules not already present, import, then REMOVE exactly
# the stubs we added (install-then-pop). Restoring is essential: under the full
# `builder nodes:test-full` run these modules are real and shared across the whole
# pytest session, so a leaked stub would break unrelated nodes' tests (e.g.
# tool_tavily, whose collection imports the real rocketlib). The v0 module binds
# `warning`/`normalize_tool_input`/`post_with_retry` into its own namespace at
# import time, so dropping the sys.modules stubs afterwards is safe.
# ---------------------------------------------------------------------------

_NODES_ROOT = Path(__file__).resolve().parent.parent / 'src' / 'nodes'
_IINSTANCE_PATH = _NODES_ROOT / 'tool_v0' / 'IInstance.py'


def _load_iinstance():
    added: list[str] = []
    for name, stub in _build_import_stubs().items():
        if name not in sys.modules:
            sys.modules[name] = stub
            added.append(name)

    # The tool_v0 package + IGlobal/IInstance entries are this test's private
    # scaffolding; always remove them afterwards so they never leak either.
    scaffold: list[str] = []
    pkg_name = 'tool_v0'
    pkg_stub = types.ModuleType(pkg_name)
    pkg_stub.__path__ = [str(_NODES_ROOT / 'tool_v0')]
    pkg_stub.__package__ = pkg_name
    sys.modules[pkg_name] = pkg_stub
    scaffold.append(pkg_name)

    iglobal_mod = types.ModuleType(f'{pkg_name}.IGlobal')
    iglobal_mod.IGlobal = type('IGlobal', (), {})
    sys.modules[f'{pkg_name}.IGlobal'] = iglobal_mod
    scaffold.append(f'{pkg_name}.IGlobal')
    pkg_stub.IGlobal = iglobal_mod

    try:
        spec = importlib.util.spec_from_file_location(
            f'{pkg_name}.IInstance',
            _IINSTANCE_PATH,
            submodule_search_locations=[],
        )
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = pkg_name
        sys.modules[f'{pkg_name}.IInstance'] = mod
        scaffold.append(f'{pkg_name}.IInstance')
        spec.loader.exec_module(mod)
    finally:
        # Drop everything we injected so nothing leaks into the shared session.
        for name in added + scaffold:
            sys.modules.pop(name, None)

    return mod


_mod = _load_iinstance()
# Rebind the names the v0 module imported into its own namespace at import time
# (`from rocketlib import warning`, `from ai.common.utils import post_with_retry,
# normalize_tool_input`). The import-time sys.modules stubs in _load_iinstance only
# take effect when those modules weren't already imported — so when a prior test on
# the same pytest worker imported the REAL `ai.common.utils`/`rocketlib`, the real
# implementations leak in and `post_with_retry` makes a live network call (HTTP 401).
# Rebinding here makes the stubbing robust regardless of import order.
_mod.warning = _stub_warning
_mod.post_with_retry = _stub_post_with_retry
_mod.normalize_tool_input = lambda args, **_kw: args if isinstance(args, dict) else {}

_shape_chat = _mod._shape_chat
IInstance = _mod.IInstance


def _make_instance() -> IInstance:
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = SimpleNamespace(apikey='test-key')
    return inst


# A canonical successful v0 Platform API chat object.
def _chat_body(chat_id='chat-abc', demo='https://v0.dev/chat/abc', files=None):
    if files is None:
        files = [{'name': 'App.tsx', 'content': 'export default function App() {}'}]
    return {'id': chat_id, 'latestVersion': {'demoUrl': demo, 'files': files}}


# =============================================================================
# (a) _shape_chat — Platform API response parsing
# =============================================================================


class TestShapeChat:
    def test_well_formed_chat_maps_all_fields(self):
        out = _shape_chat(_chat_body())
        assert out['success'] is True
        assert out['chat_id'] == 'chat-abc'
        assert out['demo_url'] == 'https://v0.dev/chat/abc'
        assert out['code'] == 'export default function App() {}'
        assert out['files'] == [{'name': 'App.tsx', 'content': 'export default function App() {}'}]
        assert 'error' not in out

    def test_first_file_used_as_code_with_multiple_files(self):
        files = [
            {'name': 'App.tsx', 'content': 'PRIMARY'},
            {'name': 'styles.css', 'content': 'SECONDARY'},
        ]
        out = _shape_chat(_chat_body(files=files))
        assert out['code'] == 'PRIMARY'
        assert len(out['files']) == 2

    def test_empty_files_raises(self):
        # Empty result → raise (firecrawl pattern); the framework converts the
        # exception into a structured error payload.
        with pytest.raises(RuntimeError, match='no files'):
            _shape_chat(_chat_body(files=[]))

    def test_missing_latest_version_raises(self):
        with pytest.raises(RuntimeError, match='no files'):
            _shape_chat({'id': 'chat-x'})

    def test_null_latest_version_raises(self):
        with pytest.raises(RuntimeError, match='no files'):
            _shape_chat({'id': 'chat-x', 'latestVersion': None})

    def test_non_dict_file_entries_skipped(self):
        files = ['oops', None, 42, {'name': 'App.tsx', 'content': 'OK'}]
        out = _shape_chat(_chat_body(files=files))
        assert out['success'] is True
        assert len(out['files']) == 1
        assert out['code'] == 'OK'

    def test_missing_demo_url_defaults_empty(self):
        body = {'id': 'c', 'latestVersion': {'files': [{'name': 'A', 'content': 'x'}]}}
        out = _shape_chat(body)
        assert out['demo_url'] == ''
        assert out['success'] is True


# =============================================================================
# (b) generate_ui
# =============================================================================


class TestGenerateUi:
    def setup_method(self):
        _reset_post()
        _reset_warnings()

    def test_missing_prompt_raises(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='prompt'):
            inst.generate_ui({})
        # No network call attempted.
        assert _POST.calls == []

    def test_success_returns_code_and_chat_id(self):
        inst = _make_instance()
        _POST.return_body = _chat_body()
        out = inst.generate_ui({'prompt': 'make a button'})
        assert out['success'] is True
        assert out['chat_id'] == 'chat-abc'
        assert out['code'] == 'export default function App() {}'
        # POSTs to /v1/chats with {message: prompt}.
        call = _POST.calls[0]
        assert call['url'].endswith('/v1/chats')
        assert call['json'] == {'message': 'make a button'}
        assert call['timeout'] == 120
        assert call['headers']['Authorization'] == 'Bearer test-key'

    def test_api_error_shape_raises(self):
        inst = _make_instance()
        _POST.return_body = {'error': {'message': 'monthly quota exceeded', 'code': 'quota'}}
        with pytest.raises(RuntimeError, match='quota exceeded'):
            inst.generate_ui({'prompt': 'make a button'})

    def test_api_error_prefers_message_over_user_message_and_code(self):
        # When several keys are present, `message` wins (it is the precise,
        # developer-facing string); userMessage/code are only fallbacks.
        inst = _make_instance()
        _POST.return_body = {'error': {'message': 'precise message', 'userMessage': 'friendly msg', 'code': 'err_code'}}
        with pytest.raises(RuntimeError) as exc_info:
            inst.generate_ui({'prompt': 'make a button'})
        text = str(exc_info.value)
        assert 'precise message' in text
        assert 'friendly msg' not in text
        assert 'err_code' not in text

    def test_non_dict_json_payload_raises_unexpected_type(self):
        # A top-level JSON array (or any non-dict) must raise rather than be
        # treated as a chat object.
        inst = _make_instance()
        _POST.return_body = [{'id': 'chat-abc'}]
        with pytest.raises(RuntimeError, match='unexpected payload type'):
            inst.generate_ui({'prompt': 'make a button'})

    def test_content_type_header_is_json(self):
        inst = _make_instance()
        _POST.return_body = _chat_body()
        inst.generate_ui({'prompt': 'make a button'})
        assert _POST.calls[0]['headers']['Content-Type'] == 'application/json'

    def test_empty_files_raises(self):
        inst = _make_instance()
        _POST.return_body = _chat_body(files=[])
        with pytest.raises(RuntimeError, match='no files'):
            inst.generate_ui({'prompt': 'make a button'})

    def test_request_exception_propagates(self):
        # post_with_retry already retries; a final failure must propagate so the
        # framework records a proper tool failure (no error-dict swallowing).
        inst = _make_instance()
        exc = RuntimeError('boom after retries')
        _POST.side_effect = exc
        with pytest.raises(RuntimeError, match='boom after retries'):
            inst.generate_ui({'prompt': 'make a button'})

    def test_non_json_body_raises_and_logs_status_only(self):
        inst = _make_instance()

        def _raising_post(url, *, headers=None, json=None, timeout=None, **_kw):
            resp = MagicMock()
            resp.status_code = 502
            resp.json.side_effect = ValueError('bad')
            return resp

        _mod.post_with_retry = _raising_post
        try:
            with pytest.raises(RuntimeError, match='non-JSON'):
                inst.generate_ui({'prompt': 'make a button'})
        finally:
            _mod.post_with_retry = _stub_post_with_retry
        # Warning logs status only, never the prompt or response body.
        assert any('status=502' in w for w in _WARNING_CALLS)
        assert all('make a button' not in w for w in _WARNING_CALLS)


# =============================================================================
# (c) refine_ui
# =============================================================================


class TestRefineUi:
    def setup_method(self):
        _reset_post()
        _reset_warnings()

    def test_missing_prompt_raises(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='prompt'):
            inst.refine_ui({'chat_id': 'chat-abc'})
        assert _POST.calls == []

    def test_missing_chat_id_raises(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='chat_id'):
            inst.refine_ui({'prompt': 'make it blue'})
        assert _POST.calls == []

    def test_success_posts_to_messages_endpoint(self):
        inst = _make_instance()
        _POST.return_body = _chat_body(chat_id='chat-abc')
        out = inst.refine_ui({'prompt': 'make it blue', 'chat_id': 'chat-abc'})
        assert out['success'] is True
        assert out['chat_id'] == 'chat-abc'
        call = _POST.calls[0]
        assert call['url'].endswith('/v1/chats/chat-abc/messages')
        assert call['json'] == {'message': 'make it blue'}

    def test_url_uses_input_chat_id_even_when_response_id_differs(self):
        # The request URL must be built from the caller-supplied chat_id, not
        # from whatever id the response happens to carry.
        inst = _make_instance()
        _POST.return_body = _chat_body(chat_id='server-side-other-id')
        out = inst.refine_ui({'prompt': 'make it blue', 'chat_id': 'input-chat-id'})
        assert _POST.calls[0]['url'].endswith('/v1/chats/input-chat-id/messages')
        # The response's own id is still surfaced as the chat_id to reuse.
        assert out['chat_id'] == 'server-side-other-id'

    def test_chat_id_falls_back_when_response_omits_id(self):
        inst = _make_instance()
        body = {'latestVersion': {'demoUrl': '', 'files': [{'name': 'A', 'content': 'x'}]}}
        _POST.return_body = body
        out = inst.refine_ui({'prompt': 'tweak', 'chat_id': 'chat-known'})
        assert out['success'] is True
        assert out['chat_id'] == 'chat-known'

    def test_api_error_shape_raises(self):
        inst = _make_instance()
        _POST.return_body = {'error': {'userMessage': 'chat not found'}}
        with pytest.raises(RuntimeError, match='chat not found'):
            inst.refine_ui({'prompt': 'tweak', 'chat_id': 'missing'})


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
