# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for tool_steadwing IInstance (no network).

Covers the Steadwing analyze-response parsing (_shape_result), the optional files
normalization (_normalize_files), and the run_rca tool method against a mocked
post_with_retry — including success, nested/`data` URL shapes, API-error and
non-JSON bodies, and the no-network input-validation paths.
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
# Stubs — installed before importing the module under test. IInstance imports
# `normalize_tool_input` and `post_with_retry` from `ai.common.utils` and
# `warning` from `rocketlib`; provide lightweight stand-ins so the module imports
# and runs without the engine runtime or network.
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
    rocketlib.debug = lambda *_a, **_k: None
    rocketlib.error = lambda *_a, **_k: None
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config')

    requests = types.ModuleType('requests')
    requests.exceptions = types.SimpleNamespace()
    requests.exceptions.Timeout = TimeoutError
    requests.exceptions.ConnectionError = ConnectionError

    class _RequestException(Exception):
        pass

    class _InvalidJSONError(_RequestException, ValueError):
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
# Inject stubs ONLY for modules not already present, import, then REMOVE exactly
# the stubs we added (install-then-pop) so nothing leaks into the shared pytest
# session under `builder nodes:test-full`.
# ---------------------------------------------------------------------------

_NODES_ROOT = Path(__file__).resolve().parent.parent / 'src' / 'nodes'
_IINSTANCE_PATH = _NODES_ROOT / 'tool_steadwing' / 'IInstance.py'


def _load_iinstance():
    added: list[str] = []
    for name, stub in _build_import_stubs().items():
        if name not in sys.modules:
            sys.modules[name] = stub
            added.append(name)

    # Scaffold keys may overwrite a pre-existing sys.modules entry; capture the
    # prior binding so the finally block can RESTORE it rather than unconditionally
    # pop, keeping full-suite test ordering deterministic.
    scaffold: list[str] = []
    _missing = object()
    previous: dict[str, object] = {}

    pkg_name = 'tool_steadwing'
    pkg_stub = types.ModuleType(pkg_name)
    pkg_stub.__path__ = [str(_NODES_ROOT / 'tool_steadwing')]
    pkg_stub.__package__ = pkg_name
    previous[pkg_name] = sys.modules.get(pkg_name, _missing)
    sys.modules[pkg_name] = pkg_stub
    scaffold.append(pkg_name)

    iglobal_key = f'{pkg_name}.IGlobal'
    iglobal_mod = types.ModuleType(iglobal_key)
    iglobal_mod.IGlobal = type('IGlobal', (), {})
    previous[iglobal_key] = sys.modules.get(iglobal_key, _missing)
    sys.modules[iglobal_key] = iglobal_mod
    scaffold.append(iglobal_key)
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
        iinstance_key = f'{pkg_name}.IInstance'
        previous[iinstance_key] = sys.modules.get(iinstance_key, _missing)
        sys.modules[iinstance_key] = mod
        scaffold.append(iinstance_key)
        spec.loader.exec_module(mod)
    finally:
        # Stubs were only inserted when absent → pop them.
        for name in added:
            sys.modules.pop(name, None)
        # Scaffold keys may have shadowed a real module → restore the prior binding.
        for name in scaffold:
            prior = previous.get(name, _missing)
            if prior is _missing:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = prior

    return mod


_mod = _load_iinstance()
# `from rocketlib import warning` binds at import time; point it at our capture.
_mod.warning = _stub_warning

_shape_result = _mod._shape_result
_normalize_files = _mod._normalize_files
IInstance = _mod.IInstance
ANALYZE_URL = _mod.STEADWING_ANALYZE_ENDPOINT


def _make_instance(apikey='test-key') -> IInstance:
    inst = IInstance.__new__(IInstance)
    inst.IGlobal = SimpleNamespace(apikey=apikey)
    return inst


# =============================================================================
# (a) _shape_result — analyze response parsing
# =============================================================================


class TestShapeResult:
    def test_root_incident_url(self):
        out = _shape_result({'incident_url': 'https://app.steadwing.com/incident/abc'})
        assert out['success'] is True
        assert out['incident_url'] == 'https://app.steadwing.com/incident/abc'
        assert 'abc' in out['message']

    def test_nested_data_incident_url(self):
        out = _shape_result({'data': {'incident_url': 'https://app.steadwing.com/incident/xyz'}})
        assert out['incident_url'] == 'https://app.steadwing.com/incident/xyz'

    def test_camelcase_incidenturl(self):
        out = _shape_result({'data': {'incidentUrl': 'https://app.steadwing.com/incident/cc'}})
        assert out['incident_url'] == 'https://app.steadwing.com/incident/cc'

    def test_generic_url_key(self):
        out = _shape_result({'url': 'https://app.steadwing.com/incident/uu'})
        assert out['incident_url'] == 'https://app.steadwing.com/incident/uu'

    def test_nested_data_preferred_over_root(self):
        out = _shape_result(
            {'data': {'incident_url': 'https://app.steadwing.com/incident/nested'}, 'incident_url': 'root'}
        )
        assert out['incident_url'] == 'https://app.steadwing.com/incident/nested'

    def test_missing_url_raises(self):
        with pytest.raises(RuntimeError, match='investigation URL'):
            _shape_result({'data': {}, 'status': 'ok'})

    def test_blank_url_raises(self):
        with pytest.raises(RuntimeError, match='investigation URL'):
            _shape_result({'incident_url': '   '})

    def test_non_dict_data_falls_back_to_root(self):
        out = _shape_result({'data': 'oops', 'incident_url': 'https://app.steadwing.com/incident/r'})
        assert out['incident_url'] == 'https://app.steadwing.com/incident/r'


# =============================================================================
# (b) _normalize_files
# =============================================================================


class TestNormalizeFiles:
    def test_none_returns_empty(self):
        assert _normalize_files(None) == []

    def test_empty_list_returns_empty(self):
        assert _normalize_files([]) == []

    def test_non_list_raises(self):
        with pytest.raises(ValueError, match='files'):
            _normalize_files({'name': 'a', 'content': 'b'})

    def test_valid_files_passed_through(self):
        files = [{'name': 'src/app.js', 'content': 'x'}, {'name': 'b.py', 'content': 'y'}]
        assert _normalize_files(files) == files

    def test_skips_non_dict_and_invalid_entries(self):
        files = [
            'oops',
            None,
            {'name': '', 'content': 'x'},  # blank name
            {'name': 'no-content'},  # missing content
            {'name': 'ok.js', 'content': 'good'},
        ]
        assert _normalize_files(files) == [{'name': 'ok.js', 'content': 'good'}]

    def test_caps_at_twenty(self):
        files = [{'name': f'f{i}.js', 'content': 'x'} for i in range(40)]
        out = _normalize_files(files)
        assert len(out) == 20

    def test_name_coerced_and_stripped(self):
        out = _normalize_files([{'name': '  a.js  ', 'content': 'x'}])
        assert out == [{'name': 'a.js', 'content': 'x'}]

    def test_non_string_content_skipped(self):
        assert _normalize_files([{'name': 'a.js', 'content': 123}]) == []


# =============================================================================
# (c) run_rca
# =============================================================================


class TestRunRca:
    def setup_method(self):
        _reset_post()
        _reset_warnings()

    def test_missing_error_raises_no_network(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='error'):
            inst.run_rca({})
        assert _POST.calls == []

    def test_blank_error_raises_no_network(self):
        inst = _make_instance()
        with pytest.raises(ValueError, match='error'):
            inst.run_rca({'error': '   '})
        assert _POST.calls == []

    def test_success_returns_incident_url(self):
        inst = _make_instance()
        _POST.return_body = {'data': {'incident_url': 'https://app.steadwing.com/incident/ok'}}
        out = inst.run_rca({'error': 'TypeError: boom at app.js:1'})
        assert out['success'] is True
        assert out['incident_url'] == 'https://app.steadwing.com/incident/ok'

    def test_posts_error_log_to_analyze_endpoint(self):
        inst = _make_instance()
        _POST.return_body = {'incident_url': 'https://app.steadwing.com/incident/ok'}
        inst.run_rca({'error': 'boom'})
        call = _POST.calls[0]
        assert call['url'] == ANALYZE_URL
        assert call['url'].endswith('/api/mcp/analyze')
        assert call['json'] == {'error_log': 'boom'}
        assert call['timeout'] == 60
        assert call['headers']['X-API-Key'] == 'test-key'
        assert call['headers']['content-type'] == 'application/json'

    def test_files_included_when_provided(self):
        inst = _make_instance()
        _POST.return_body = {'incident_url': 'https://app.steadwing.com/incident/ok'}
        inst.run_rca({'error': 'boom', 'files': [{'name': 'app.js', 'content': 'code'}]})
        assert _POST.calls[0]['json']['files'] == [{'name': 'app.js', 'content': 'code'}]

    def test_files_omitted_when_empty(self):
        inst = _make_instance()
        _POST.return_body = {'incident_url': 'https://app.steadwing.com/incident/ok'}
        inst.run_rca({'error': 'boom', 'files': []})
        assert 'files' not in _POST.calls[0]['json']

    def test_api_error_dict_raises(self):
        inst = _make_instance()
        _POST.return_body = {'error': {'message': 'monthly RCA quota exceeded', 'code': 'quota'}}
        with pytest.raises(RuntimeError, match='quota exceeded'):
            inst.run_rca({'error': 'boom'})

    def test_api_error_string_raises(self):
        inst = _make_instance()
        _POST.return_body = {'error': 'unauthorized'}
        with pytest.raises(RuntimeError, match='unauthorized'):
            inst.run_rca({'error': 'boom'})

    def test_non_dict_payload_raises(self):
        inst = _make_instance()
        _POST.return_body = ['not', 'a', 'dict']
        with pytest.raises(RuntimeError, match='unexpected payload type'):
            inst.run_rca({'error': 'boom'})

    def test_missing_url_raises(self):
        inst = _make_instance()
        _POST.return_body = {'status': 'accepted'}
        with pytest.raises(RuntimeError, match='investigation URL'):
            inst.run_rca({'error': 'boom'})

    def test_request_exception_propagates(self):
        # post_with_retry already retries; a final failure must propagate so the
        # framework records a proper tool failure (no error-dict swallowing).
        inst = _make_instance()
        _POST.side_effect = RuntimeError('boom after retries')
        with pytest.raises(RuntimeError, match='boom after retries'):
            inst.run_rca({'error': 'boom'})

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
                inst.run_rca({'error': 'super-secret stack trace'})
        finally:
            _mod.post_with_retry = _stub_post_with_retry
        # Warning logs status only — never the submitted error context or the key.
        assert any('status=502' in w for w in _WARNING_CALLS)
        assert all('super-secret' not in w for w in _WARNING_CALLS)
        assert all('test-key' not in w for w in _WARNING_CALLS)

    def test_api_key_never_logged_on_error(self):
        inst = _make_instance(apikey='st_supersecret')
        _POST.return_body = {'error': {'message': 'bad request'}}
        with pytest.raises(RuntimeError):
            inst.run_rca({'error': 'boom'})
        assert all('st_supersecret' not in w for w in _WARNING_CALLS)


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-v']))
