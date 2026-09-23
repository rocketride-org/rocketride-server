# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool_docs node (no network, no engine runtime).

Bootstrap mirrors test_sheets.py: inject lightweight stubs for the engine
runtime modules ONLY if absent, import the module under test, then drop the
stubs so they never leak into a shared pytest session. The Google SDK is never
imported — IInstance receives a FakeDocs service and a real GoogleAccess.
"""

from __future__ import annotations

import importlib
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[3] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))

_SERVICES_JSON = _NODES_SRC / 'nodes' / 'tool_google_workspace' / 'services.docs.json'


def _require_str(args, key, *, tool_name=''):
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{tool_name or key}: "{key}" is required')
    return value.strip()


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = _require_str

    def _stub_require_int(args, key, *, lo=None, hi=None, tool_name=''):
        prefix = f'{tool_name}: ' if tool_name else ''
        val = args.get(key)
        if val is None:
            raise ValueError(f'{prefix}"{key}" is required')
        if isinstance(val, (bool, float)) or not isinstance(val, (int, str)):
            raise ValueError(f'{prefix}"{key}" must be an integer')
        try:
            out = int(val)
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f'{prefix}"{key}" must be an integer')
        if (lo is not None and out < lo) or (hi is not None and out > hi):
            raise ValueError(f'{prefix}"{key}" must be an integer')
        return out

    def _stub_optional_int(args, key, *, default=None, lo=None, hi=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        return _stub_require_int(args, key, lo=lo, hi=hi, tool_name=tool_name)

    def _stub_optional_str(args, key, *, default=None, tool_name=''):
        if key not in args or args[key] is None:
            return default
        val = args[key]
        if not isinstance(val, str):
            prefix = f'{tool_name}: ' if tool_name else ''
            raise ValueError(f'{prefix}"{key}" must be a string')
        return val

    ai_common_utils.require_int = _stub_require_int
    ai_common_utils.optional_int = _stub_optional_int
    ai_common_utils.optional_str = _stub_optional_str

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
    }


_added = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added.append(_name)

docs_iinstance = importlib.import_module('nodes.tool_google_workspace.docs.IInstance')
docs_client = importlib.import_module('nodes.tool_google_workspace.docs.client')
docs_iglobal = importlib.import_module('nodes.tool_google_workspace.docs.IGlobal')
workspace_client = importlib.import_module('nodes.tool_google_workspace.google_client')
workspace_iglobal = importlib.import_module('nodes.tool_google_workspace.IGlobal')
workspace_iinstance = importlib.import_module('nodes.tool_google_workspace.IInstance')
ga = importlib.import_module('nodes.core.google_access')

for _name in _added:
    sys.modules.pop(_name, None)


# ---------------------------------------------------------------------------
# Fake Docs service: records terminal calls, returns canned results.
# ---------------------------------------------------------------------------

# Intermediate resource nodes (return another node); everything else is a
# terminal method that records its call and returns a canned result.
_RESOURCES = {'documents'}


class _Req:
    def __init__(self, result):
        self.result = result

    def execute(self):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


class _Node:
    def __init__(self, sv, path):
        self._sv = sv
        self._path = path

    def __getattr__(self, name):
        def method(**kwargs):
            if name in _RESOURCES:
                return _Node(self._sv, f'{self._path}.{name}')
            self._sv.calls.append((name, kwargs))
            return _Req(self._sv.results.get(name, {}))

        return method


class FakeDocs:
    def __init__(self, results=None):
        self.calls = []
        self.results = results or {}

    def documents(self):
        return _Node(self, 'documents')

    def call_for(self, op):
        """Return the kwargs of the first recorded call to terminal method ``op``."""
        return next((kw for n, kw in self.calls if n == op), None)

    def calls_for(self, op):
        """Return the kwargs of every recorded call to terminal method ``op``."""
        return [kw for n, kw in self.calls if n == op]


def _make(tier='write', results=None):
    """Build an IInstance wired to a FakeDocs and a real resolved GoogleAccess."""
    inst = docs_iinstance.IInstance()
    access = ga.resolve_google_access({'access': tier}, ga.DOCS)
    inst.IGlobal = types.SimpleNamespace(service=FakeDocs(results or {}), access=access)
    return inst


# ---------------------------------------------------------------------------
# Read — document_get
# ---------------------------------------------------------------------------


def _doc_with_text(text_runs, *, document_id='d1', title='Doc', revision='rev1'):
    """Build a raw Document with the given paragraph text-run strings."""
    return {
        'documentId': document_id,
        'title': title,
        'revisionId': revision,
        'body': {
            'content': [
                {'paragraph': {'elements': [{'textRun': {'content': run}} for run in text_runs]}},
            ]
        },
    }


def test_document_get_cleans_and_concatenates_text():
    raw = _doc_with_text(['Hello ', 'world.\n'])
    inst = _make(results={'get': raw})
    out = inst.document_get({'documentId': 'd1'})
    assert out == {
        'documentId': 'd1',
        'title': 'Doc',
        'revisionId': 'rev1',
        'body_text': 'Hello world.\n',
        'truncated': False,
    }
    call = inst.IGlobal.service.call_for('get')
    assert call['documentId'] == 'd1'
    assert call['fields'] == 'documentId,title,revisionId,body(content(paragraph(elements(textRun(content)))))'


def test_document_get_requires_document_id():
    inst = _make()
    with pytest.raises(ValueError):
        inst.document_get({})


def test_document_get_works_at_readonly():
    inst = _make(tier='readonly', results={'get': _doc_with_text(['ok'])})
    out = inst.document_get({'documentId': 'd1'})
    assert out['body_text'] == 'ok'
    assert inst.IGlobal.access.can_write is False


def test_document_get_truncation_flag():
    long_run = 'x' * 60000
    inst = _make(results={'get': _doc_with_text([long_run])})
    out = inst.document_get({'documentId': 'd1'})
    assert out['truncated'] is True
    assert len(out['body_text']) == 50000


def test_document_get_non_paragraph_content_ignored():
    raw = {
        'documentId': 'd1',
        'title': 'T',
        'revisionId': 'r',
        'body': {
            'content': [
                {'sectionBreak': {}},
                {'paragraph': {'elements': [{'textRun': {'content': 'kept'}}, {'inlineObjectElement': {}}]}},
                {'table': {'rows': 2}},
            ]
        },
    }
    inst = _make(results={'get': raw})
    out = inst.document_get({'documentId': 'd1'})
    assert out['body_text'] == 'kept'


# ---------------------------------------------------------------------------
# Access tiers / diagnostics / contract
# ---------------------------------------------------------------------------


def test_default_tier_is_write():
    access = ga.resolve_google_access({}, ga.DOCS)
    assert access.tier == 'write'
    assert access.can_write is True


class _HttpErr(Exception):
    def __init__(self, status, reason, content=b''):
        super().__init__(reason)
        self.resp = types.SimpleNamespace(status=status)
        self.reason = reason
        self.content = content


def test_check_connection_reports_ok():
    inst = _make()
    out = inst.check_connection({})
    assert isinstance(out, dict)
    assert out['connection_ok'] is True
    assert out['access'] == 'write'
    assert any('documents' in s for s in out['requiredScopes'])
    assert inst.IGlobal.service.call_for('get') is not None


def test_check_connection_impl_reports_unknown_without_a_probe():
    """The shared base must not default an unverified connection to True."""
    inst = _make()
    out = inst._check_connection_impl()
    assert out['connection_ok'] == 'unknown'
    assert out['checked'] == ['client']


def test_check_connection_probe_swallows_expected_404():
    """A 404 on the probe's made-up document id proves the Docs API IS reachable."""
    inst = _make(results={'get': _HttpErr(404, 'notFound')})
    out = inst.check_connection({})
    assert out['connection_ok'] is True


def test_check_connection_reports_probe_failure():
    """A disabled Docs API (accessNotConfigured) must flip connection_ok, not be swallowed."""
    err = _HttpErr(403, 'Forbidden', content=b'{"error": {"errors": [{"reason": "accessNotConfigured"}]}}')
    inst = _make(results={'get': err})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert out['errorReason'] == 'accessNotConfigured'


def test_check_connection_reports_missing_user_auth_scopes(monkeypatch):
    inst = _make()
    inst.IGlobal.glb = SimpleNamespace(logicalType='tool_docs', connConfig='conn1')
    config = SimpleNamespace(
        getNodeConfig=lambda logical_type, conn_config: {
            'authType': 'user',
            'userToken': json.dumps({'scope': 'https://www.googleapis.com/auth/drive.file'}),
        }
    )
    monkeypatch.setattr(workspace_iinstance, 'Config', config)

    out = inst.check_connection({})

    assert out['connection_ok'] is False
    assert out['missingScopes'] == ['https://www.googleapis.com/auth/documents']


def test_services_json_shape():
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    assert data['title'] == 'Google Docs'
    assert data['protocol'] == 'tool_docs://'
    assert data['classType'] == ['tool']
    assert data['capabilities'] == ['invoke']
    assert data['lanes'] == {}  # tool node: no data lanes
    assert data['prefix'] == 'docs'
    assert data['path'] == 'nodes.tool_google_workspace.docs'
    assert data['icon'] == 'docs.svg'
    assert 'docs.access' in data['fields']
    assert data['fields']['docs.access']['default'] == 'write'
    assert [row[0] for row in data['fields']['docs.access']['enum']] == ['readonly', 'write']
    assert data['shape'][0]['properties'] == ['type', 'google.authType', 'docs.access']
    # OAuth node: the framework can't drive it without live creds, so no dynamic test block.
    assert 'test' not in data


def test_services_json_no_secret_defaults():
    """Secrets must never carry a real default (gitleaks scans services*.json)."""
    data = json.loads(_SERVICES_JSON.read_text(encoding='utf-8'))
    for prof in data['preconfig']['profiles'].values():
        assert prof.get('serviceKey', '') == ''
        assert prof.get('userToken', '') == ''


# ---------------------------------------------------------------------------
# document_create
# ---------------------------------------------------------------------------


def test_document_create_title_only():
    inst = _make(results={'create': _doc_with_text([], document_id='new1', title='Fresh', revision='r0')})
    out = inst.document_create({'title': 'Fresh'})
    assert out == {
        'documentId': 'new1',
        'title': 'Fresh',
        'revisionId': 'r0',
        'body_text': '',
        'truncated': False,
    }
    assert inst.IGlobal.service.call_for('create')['body'] == {'title': 'Fresh'}
    # No initial text => no follow-up batchUpdate.
    assert inst.IGlobal.service.call_for('batchUpdate') is None


def test_document_create_with_initial_text_inserts():
    inst = _make(
        results={
            'create': _doc_with_text([], document_id='new1', title='Fresh'),
            'batchUpdate': {'documentId': 'new1', 'replies': [{}]},
            'get': _doc_with_text(['Intro line'], document_id='new1', title='Fresh', revision='r1'),
        }
    )
    out = inst.document_create({'title': 'Fresh', 'text': 'Intro line'})
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    assert body == {'requests': [{'insertText': {'endOfSegmentLocation': {}, 'text': 'Intro line'}}]}
    assert inst.IGlobal.service.call_for('batchUpdate')['documentId'] == 'new1'
    assert inst.IGlobal.service.call_for('get')['documentId'] == 'new1'
    assert out['body_text'] == 'Intro line'


def test_document_create_empty_text_skips_insert():
    inst = _make(results={'create': _doc_with_text([], document_id='new1')})
    inst.document_create({'title': 'Fresh', 'text': ''})
    assert inst.IGlobal.service.call_for('batchUpdate') is None


def test_document_create_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.document_create({'title': 'Fresh'})


def test_document_create_requires_title():
    inst = _make()
    with pytest.raises(ValueError):
        inst.document_create({})


# ---------------------------------------------------------------------------
# batch_update (catch-all)
# ---------------------------------------------------------------------------


def test_batch_update_passthrough():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}, {}]}})
    reqs = [{'insertText': {'location': {'index': 1}, 'text': 'x'}}, {'updateParagraphStyle': {}}]
    out = inst.batch_update({'documentId': 'd1', 'requests': reqs})
    assert out == {'documentId': 'd1', 'replies_count': 2, 'replies': [{}, {}]}
    assert inst.IGlobal.service.call_for('batchUpdate')['body']['requests'] == reqs


def test_batch_update_requires_nonempty_requests():
    inst = _make()
    with pytest.raises(ValueError):
        inst.batch_update({'documentId': 'd1', 'requests': []})


def test_batch_update_rejects_non_object_request():
    inst = _make()
    with pytest.raises(ValueError):
        inst.batch_update({'documentId': 'd1', 'requests': ['not-an-object']})


def test_batch_update_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.batch_update({'documentId': 'd1', 'requests': [{'x': 1}]})


# ---------------------------------------------------------------------------
# text_append
# ---------------------------------------------------------------------------


def test_text_append_builds_exact_request():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    out = inst.text_append({'documentId': 'd1', 'text': 'appended'})
    assert out == {'documentId': 'd1', 'replies_count': 1, 'replies': [{}]}
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    assert body == {'requests': [{'insertText': {'endOfSegmentLocation': {}, 'text': 'appended'}}]}


def test_text_append_requires_text():
    inst = _make()
    with pytest.raises(ValueError):
        inst.text_append({'documentId': 'd1'})


def test_text_append_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.text_append({'documentId': 'd1', 'text': 'x'})


# ---------------------------------------------------------------------------
# text_replace
# ---------------------------------------------------------------------------


def test_text_replace_builds_request_and_returns_count():
    inst = _make(
        results={
            'batchUpdate': {
                'documentId': 'd1',
                'replies': [{'replaceAllText': {'occurrencesChanged': 4}}],
            }
        }
    )
    out = inst.text_replace({'documentId': 'd1', 'containsText': 'foo', 'text': 'bar'})
    assert out == {'documentId': 'd1', 'occurrencesChanged': 4}
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    # matchCase is always sent explicitly (defaults to False), never left implicit.
    assert body == {
        'requests': [
            {
                'replaceAllText': {
                    'containsText': {'text': 'foo', 'matchCase': False},
                    'replaceText': 'bar',
                }
            }
        ]
    }


def test_text_replace_honors_match_case_true():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{'replaceAllText': {}}]}})
    inst.text_replace({'documentId': 'd1', 'containsText': 'Foo', 'text': 'bar', 'matchCase': True})
    ct = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['replaceAllText']['containsText']
    assert ct['matchCase'] is True


def test_text_replace_rejects_nonbool_match_case():
    inst = _make()
    with pytest.raises(ValueError):
        inst.text_replace({'documentId': 'd1', 'containsText': 'a', 'text': 'b', 'matchCase': 'yes'})


def test_text_replace_defaults_occurrences_to_zero():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    out = inst.text_replace({'documentId': 'd1', 'containsText': 'a', 'text': 'b'})
    assert out['occurrencesChanged'] == 0


def test_text_replace_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.text_replace({'documentId': 'd1', 'containsText': 'a', 'text': 'b'})


# ---------------------------------------------------------------------------
# image_insert
# ---------------------------------------------------------------------------


def test_image_insert_builds_request_with_size():
    inst = _make(
        results={'batchUpdate': {'documentId': 'd1', 'replies': [{'insertInlineImage': {'objectId': 'img1'}}]}}
    )
    out = inst.image_insert({'documentId': 'd1', 'uri': 'https://example.com/a.png', 'width': 200, 'height': 100})
    assert out['replies'][0]['insertInlineImage']['objectId'] == 'img1'
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['insertInlineImage']
    assert req == {
        'endOfSegmentLocation': {},
        'uri': 'https://example.com/a.png',
        'objectSize': {
            'width': {'magnitude': 200, 'unit': 'PT'},
            'height': {'magnitude': 100, 'unit': 'PT'},
        },
    }


def test_image_insert_without_size_omits_object_size():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    inst.image_insert({'documentId': 'd1', 'uri': 'https://example.com/a.png'})
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['insertInlineImage']
    assert req == {'endOfSegmentLocation': {}, 'uri': 'https://example.com/a.png'}


def test_image_insert_rejects_http_uri():
    inst = _make()
    with pytest.raises(ValueError):
        inst.image_insert({'documentId': 'd1', 'uri': 'http://example.com/a.png'})


def test_image_insert_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.image_insert({'documentId': 'd1', 'uri': 'https://example.com/a.png'})


# ---------------------------------------------------------------------------
# table_insert
# ---------------------------------------------------------------------------


def test_table_insert_builds_request():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    out = inst.table_insert({'documentId': 'd1', 'rows': 3, 'columns': 2})
    assert out == {'documentId': 'd1', 'replies_count': 1, 'replies': [{}]}
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['insertTable']
    assert req == {'endOfSegmentLocation': {}, 'rows': 3, 'columns': 2}


def test_table_insert_clamps_bounds():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    inst.table_insert({'documentId': 'd1', 'rows': 5000, 'columns': 99})
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['insertTable']
    assert req['rows'] == 1000  # clamped 1..1000
    assert req['columns'] == 25  # clamped 1..25


def test_table_insert_clamps_low():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    inst.table_insert({'documentId': 'd1', 'rows': 0, 'columns': -3})
    req = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['insertTable']
    assert req['rows'] == 1 and req['columns'] == 1


def test_table_insert_rejects_bool_rows():
    # JSON true must never be coerced to 1.
    inst = _make()
    with pytest.raises(ValueError):
        inst.table_insert({'documentId': 'd1', 'rows': True, 'columns': 2})


def test_table_insert_rejects_bool_and_float_dimensions():
    # Shared require_int semantics: numeric strings coerce, bool/float reject.
    inst = _make()
    for bad in (True, 2.5, [2]):
        with pytest.raises(ValueError):
            inst.table_insert({'documentId': 'd1', 'rows': 2, 'columns': bad})


def test_table_insert_coerces_numeric_string_dimensions():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    inst.table_insert({'documentId': 'd1', 'rows': '2', 'columns': '3'})
    table = inst.IGlobal.service.call_for('batchUpdate')['body']['requests'][0]['insertTable']
    assert table['rows'] == 2 and table['columns'] == 3


def test_table_insert_denied_on_readonly():
    inst = _make(tier='readonly')
    with pytest.raises(ga.GoogleAccessError):
        inst.table_insert({'documentId': 'd1', 'rows': 2, 'columns': 2})


# ---------------------------------------------------------------------------
# API error surfacing
# ---------------------------------------------------------------------------


def test_execute_wraps_api_error_as_valueerror():
    inst = _make(results={'get': RuntimeError('boom')})
    with pytest.raises(ValueError):
        inst.document_get({'documentId': 'd1'})


# ---------------------------------------------------------------------------
# Completeness
# ---------------------------------------------------------------------------


def test_all_eight_tools_present():
    expected = {
        'check_connection',
        'document_get',
        'document_create',
        'batch_update',
        'text_append',
        'text_replace',
        'image_insert',
        'table_insert',
    }
    for name in expected:
        assert callable(getattr(docs_iinstance.IInstance, name)), f'missing tool: {name}'


# ---------------------------------------------------------------------------
# Scope diagnostics
# ---------------------------------------------------------------------------


def test_token_scope_report_covered_missing_absent_and_malformed():
    required = ['https://www.googleapis.com/auth/documents']
    assert workspace_client.token_scope_report(docs_client.SERVICE, {}, required) == (set(), True, [])
    covered_cfg = {'userToken': '{"scope": "https://www.googleapis.com/auth/documents"}'}
    granted, covered, missing = workspace_client.token_scope_report(docs_client.SERVICE, covered_cfg, required)
    assert covered is True and missing == []
    other_cfg = {'userToken': '{"scope": "https://www.googleapis.com/auth/unrelated"}'}
    granted, covered, missing = workspace_client.token_scope_report(docs_client.SERVICE, other_cfg, required)
    assert covered is False and missing == required
    with pytest.raises(ValueError):
        workspace_client.token_scope_report(docs_client.SERVICE, {'userToken': '{bad'}, required)


def test_document_create_seed_failure_returns_id_with_warning():
    inst = _make(
        results={
            'create': _doc_with_text([], document_id='d9', title='T', revision='r0'),
            'batchUpdate': RuntimeError('boom'),
        }
    )
    out = inst.document_create({'title': 'T', 'text': 'seed'})
    assert out['documentId'] == 'd9'
    assert 'd9' in out['warning'] and 'document_create' not in out.get('body_text', '')


def test_document_create_rejects_non_string_text_before_creating():
    inst = _make()
    with pytest.raises(ValueError):
        inst.document_create({'title': 'T', 'text': 123})
    assert inst.IGlobal.service.call_for('create') is None  # nothing was created


# ---------------------------------------------------------------------------
# Review round: whitespace-significant text + malformed-token diagnostics
# ---------------------------------------------------------------------------


def test_text_append_preserves_whitespace_verbatim():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{}]}})
    inst.text_append({'documentId': 'd1', 'text': '\n\nNext paragraph'})
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    assert body['requests'][0]['insertText']['text'] == '\n\nNext paragraph'


def test_text_append_rejects_empty_text():
    inst = _make()
    with pytest.raises(ValueError, match='non-empty'):
        inst.text_append({'documentId': 'd1', 'text': ''})


def test_text_replace_empty_replacement_deletes_occurrences():
    inst = _make(
        results={'batchUpdate': {'documentId': 'd1', 'replies': [{'replaceAllText': {'occurrencesChanged': 2}}]}}
    )
    out = inst.text_replace({'documentId': 'd1', 'containsText': '{{draft}}', 'text': ''})
    assert out['occurrencesChanged'] == 2
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    assert body['requests'][0]['replaceAllText']['replaceText'] == ''


def test_text_replace_preserves_replacement_whitespace():
    inst = _make(results={'batchUpdate': {'documentId': 'd1', 'replies': [{'replaceAllText': {}}]}})
    inst.text_replace({'documentId': 'd1', 'containsText': 'x', 'text': 'x '})
    body = inst.IGlobal.service.call_for('batchUpdate')['body']
    assert body['requests'][0]['replaceAllText']['replaceText'] == 'x '


def test_check_connection_reports_malformed_token(monkeypatch):
    class _Cfg:
        @staticmethod
        def getNodeConfig(*_a, **_k):
            return {'authType': 'user', 'userToken': '{bad json'}

    monkeypatch.setattr(workspace_iinstance, 'Config', _Cfg)
    inst = _make()
    inst.IGlobal.glb = types.SimpleNamespace(logicalType='tool_docs', connConfig={})
    out = inst.check_connection({})
    assert out['connection_ok'] is False
    assert 'invalid user token' in out['scopeError']


def test_validate_config_warns_for_malformed_user_token(monkeypatch):
    warnings = []
    monkeypatch.setattr(
        workspace_iglobal.Config, 'getNodeConfig', lambda *a, **k: {'authType': 'user', 'userToken': '{bad json'}
    )
    monkeypatch.setattr(workspace_iglobal, 'warning', warnings.append)
    glb = docs_iglobal.IGlobal()
    glb.glb = types.SimpleNamespace(logicalType='docs', connConfig={})
    glb.validateConfig()
    assert any('invalid' in message.lower() for message in warnings)
