# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for tool_v0 IInstance pure-logic helpers."""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# rocketlib stub — must be installed before importing the module under test
# ---------------------------------------------------------------------------

_WARNING_CALLS: list[str] = []


def _reset_warnings() -> None:
    _WARNING_CALLS.clear()


def _stub_warning(msg: str, *_a: object, **_k: object) -> None:
    _WARNING_CALLS.append(msg)


def _install_rocketlib_stub() -> None:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda *_a, **_k: lambda fn: fn
    rocketlib.warning = _stub_warning
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')
    sys.modules.setdefault('rocketlib', rocketlib)

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    ai_common = types.ModuleType('ai.common')
    ai_common.__path__ = []
    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = MagicMock()
    sys.modules.setdefault('ai', ai_pkg)
    sys.modules.setdefault('ai.common', ai_common)
    sys.modules.setdefault('ai.common.config', ai_config)


_install_rocketlib_stub()

# ---------------------------------------------------------------------------
# Load the module under test via importlib so we avoid package __init__ chains
# ---------------------------------------------------------------------------

_NODES_ROOT = Path(__file__).resolve().parent.parent / 'src' / 'nodes'
_IINSTANCE_PATH = _NODES_ROOT / 'tool_v0' / 'IInstance.py'


def _load_iinstance():
    # The module uses `from .IGlobal import IGlobal` so it needs a parent package.
    # Register a fake package 'tool_v0' and its IGlobal sub-module in sys.modules
    # so the relative import resolves without a real filesystem package.
    pkg_name = 'tool_v0'
    pkg_stub = types.ModuleType(pkg_name)
    pkg_stub.__path__ = [str(_NODES_ROOT / 'tool_v0')]
    pkg_stub.__package__ = pkg_name
    sys.modules[pkg_name] = pkg_stub

    iglobal_mod = types.ModuleType(f'{pkg_name}.IGlobal')
    iglobal_mod.IGlobal = type('IGlobal', (), {})
    sys.modules[f'{pkg_name}.IGlobal'] = iglobal_mod
    pkg_stub.IGlobal = iglobal_mod

    spec = importlib.util.spec_from_file_location(
        f'{pkg_name}.IInstance',
        _IINSTANCE_PATH,
        submodule_search_locations=[],
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = pkg_name
    sys.modules[f'{pkg_name}.IInstance'] = mod
    spec.loader.exec_module(mod)
    return mod


_mod = _load_iinstance()
# Force the loaded module's `warning` reference to our stub. Required because
# `from rocketlib import warning` binds the name at import time, so when the
# real rocketlib is already in sys.modules (e.g. on CI inside the engine
# pytest runner) our sys.modules stub is ignored and _mod.warning points at
# the engine's logger. Overriding the attribute on the loaded module patches
# the actual reference used by _normalize_tool_input.
_mod.warning = _stub_warning

_normalize_tool_input = _mod._normalize_tool_input
_extract_code = _mod._extract_code
IInstance = _mod.IInstance


# ---------------------------------------------------------------------------
# Helper: build a minimal IInstance without calling __init__
# ---------------------------------------------------------------------------


def _make_instance() -> IInstance:
    inst = IInstance.__new__(IInstance)
    iglobal = SimpleNamespace(apikey='test-key')
    inst.IGlobal = iglobal
    return inst


# =============================================================================
# (a) _normalize_tool_input
# =============================================================================


class TestNormalizeToolInput:
    def setup_method(self):
        _reset_warnings()

    def test_none_returns_empty_dict(self):
        assert _normalize_tool_input(None) == {}

    def test_json_string_parsed_to_dict(self):
        result = _normalize_tool_input(json.dumps({'prompt': 'hello'}))
        assert result == {'prompt': 'hello'}

    def test_object_with_model_dump_converted(self):
        obj = SimpleNamespace()
        obj.model_dump = lambda: {'prompt': 'from_pydantic'}
        result = _normalize_tool_input(obj)
        assert result == {'prompt': 'from_pydantic'}

    def test_nested_input_key_flattened(self):
        nested = {'input': {'prompt': 'hi', 'model': 'v0-1.0-md'}, 'extra': 'val'}
        result = _normalize_tool_input(nested)
        assert result['prompt'] == 'hi'
        assert result['model'] == 'v0-1.0-md'
        assert result['extra'] == 'val'
        assert 'input' not in result

    def test_security_context_stripped(self):
        data = {'prompt': 'test', 'security_context': {'token': 'secret'}}
        result = _normalize_tool_input(data)
        assert 'security_context' not in result
        assert result['prompt'] == 'test'

    def test_non_dict_type_logs_type_name_only(self):
        _normalize_tool_input(42)
        assert len(_WARNING_CALLS) == 1
        assert 'int' in _WARNING_CALLS[0]
        # Must not contain the actual value
        assert '42' not in _WARNING_CALLS[0]

    def test_non_dict_list_logs_type_name_only(self):
        _reset_warnings()
        _normalize_tool_input(['secret_value_xyz', 'other_secret'])
        assert len(_WARNING_CALLS) == 1
        assert 'list' in _WARNING_CALLS[0]
        # Raw list contents must not appear in the warning
        assert 'secret_value_xyz' not in _WARNING_CALLS[0]
        assert 'other_secret' not in _WARNING_CALLS[0]

    def test_non_dict_returns_empty_dict(self):
        result = _normalize_tool_input(12345)
        assert result == {}


# =============================================================================
# (b) _extract_code
# =============================================================================


class TestExtractCode:
    def test_empty_choices_returns_empty_strings(self):
        code, msg_id = _extract_code({})
        assert code == ''
        assert msg_id == ''

    def test_empty_choices_list_returns_empty_strings(self):
        code, msg_id = _extract_code({'choices': []})
        assert code == ''
        assert msg_id == ''

    def test_well_formed_response_extracts_code_and_id(self):
        response = {
            'id': 'msg-abc123',
            'choices': [{'message': {'content': 'export default function App() {}', 'role': 'assistant'}}],
        }
        code, msg_id = _extract_code(response)
        assert code == 'export default function App() {}'
        assert msg_id == 'msg-abc123'

    def test_missing_message_field_returns_empty_strings(self):
        response = {
            'id': 'msg-xyz',
            'choices': [{'finish_reason': 'stop'}],
        }
        code, msg_id = _extract_code(response)
        assert code == ''
        assert msg_id == 'msg-xyz'


# =============================================================================
# (c) generate_ui
# =============================================================================


class TestGenerateUi:
    def test_missing_prompt_returns_error(self):
        inst = _make_instance()
        result = inst.generate_ui({})
        assert result['success'] is False
        assert 'prompt' in result['error']

    def test_http_status_error_returns_failure(self):
        import httpx

        inst = _make_instance()
        mock_response = MagicMock()
        mock_response.status_code = 401
        err = httpx.HTTPStatusError('Unauthorized', request=MagicMock(), response=mock_response)

        with patch.object(inst, '_call_v0_api', side_effect=err):
            result = inst.generate_ui({'prompt': 'make a button'})

        assert result['success'] is False
        assert 'error' in result

    def test_empty_choices_returns_no_code_generated(self):
        inst = _make_instance()
        with patch.object(inst, '_call_v0_api', return_value={'choices': [], 'id': 'x'}):
            result = inst.generate_ui({'prompt': 'make a button'})

        assert result['success'] is False
        assert result['error'] == 'No code generated'


# =============================================================================
# (d) refine_ui
# =============================================================================


class TestRefineUi:
    def test_missing_message_id_returns_error(self):
        inst = _make_instance()
        result = inst.refine_ui({'prompt': 'change color to blue'})
        assert result['success'] is False
        assert 'message_id' in result['error']

    def test_prior_messages_forwarded_into_call(self):
        inst = _make_instance()
        prior = [
            {'role': 'user', 'content': 'make a button'},
            {'role': 'assistant', 'content': 'export default function Btn() {}'},
        ]
        good_response = {
            'id': 'msg-new',
            'choices': [{'message': {'content': 'export default function Btn2() {}'}}],
        }

        with patch.object(inst, '_call_v0_api', return_value=good_response) as mock_call:
            result = inst.refine_ui(
                {
                    'prompt': 'change color to blue',
                    'message_id': 'msg-old',
                    'prior_messages': prior,
                }
            )

        assert result['success'] is True
        _args, _kwargs = mock_call.call_args
        messages_sent = _args[0]
        # prior messages must appear at the start
        assert messages_sent[:2] == prior
        # new user turn must be appended
        assert messages_sent[-1] == {'role': 'user', 'content': 'change color to blue'}
        # parent_message_id passed as kwarg
        assert _kwargs.get('parent_message_id') == 'msg-old'
