# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for tool_github keyword-search relax fallback (#1363).

GitHub free-text search ANDs every term, so a verbose natural-language query
(what agents tend to pass) matches nothing. ``_relax_query`` rebuilds such a
query as an OR of its keywords — preserving GitHub qualifiers (``repo:``/
``is:``) and capping terms so the query stays under GitHub's five-operator
limit. ``search_issues``/``search_code`` retry once with the relaxed query when
the first pass returns no items.

These tests stub the node's heavy imports (``rocketlib``, ``ai.common.*``) and
monkeypatch ``mod.call`` so nothing touches the network.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _build_import_stubs():
    """Stub exactly the deps tool_github's IInstance/IGlobal import."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f  # pass-through decorator
    rocketlib.OPEN_MODE = MagicMock()
    rocketlib.warning = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}
    ai_common_utils.require_str = lambda args, key, **kw: (args.get(key) or '').strip()
    ai_common_utils.require_int = lambda args, key, **kw: int(args.get(key))

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': MagicMock(),
        'requests': MagicMock(),
    }


# Import nodes.tool_github.IInstance under controlled stubs, then restore
# sys.modules exactly (same isolation discipline as test_tool_deepl.py).
_GH_MODULES = ('nodes.tool_github.IInstance', 'nodes.tool_github.IGlobal', 'nodes.tool_github')
_stubs = _build_import_stubs()
_touched = list(_stubs) + list(_GH_MODULES)
_ABSENT = object()
_saved = {name: sys.modules.get(name, _ABSENT) for name in _touched}

try:
    for _name, _stub in _stubs.items():
        sys.modules[_name] = _stub
    for _name in _GH_MODULES:
        sys.modules.pop(_name, None)
    mod = importlib.import_module('nodes.tool_github.IInstance')
finally:
    for _name in _touched:
        _prev = _saved[_name]
        if _prev is _ABSENT:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _prev


_VERBOSE = (
    "i'm having an issue with the dropper Browse file buttons it's not working "
    'when i click it but if i click the surrounding box it works'
)


# ---------------------------------------------------------------------------
# _relax_query — pure string transform
# ---------------------------------------------------------------------------


class TestRelaxQuery:
    def test_verbose_query_relaxes_to_capped_or_clause(self):
        q = f'{_VERBOSE} repo:rocketride-org/rocketride-server is:open'
        relaxed = mod._relax_query(q)
        assert relaxed is not None
        # qualifiers preserved verbatim
        assert 'repo:rocketride-org/rocketride-server' in relaxed
        assert 'is:open' in relaxed
        # OR clause present, capped to <= 5 terms => <= 4 OR operators (GitHub caps at 5)
        assert ' OR ' in relaxed
        assert relaxed.count(' OR ') <= 4
        or_clause = relaxed.split(' repo:')[0]
        assert len(or_clause.split(' OR ')) <= 5
        # stopwords dropped
        assert 'OR having' not in relaxed and 'OR the ' not in relaxed

    def test_single_term_not_relaxable(self):
        assert mod._relax_query('dropper repo:acme/app') is None

    def test_qualifiers_only_not_relaxable(self):
        assert mod._relax_query('repo:acme/app is:issue') is None

    def test_all_stopwords_not_relaxable(self):
        assert mod._relax_query('it is the my me when') is None

    def test_two_terms_relax_and_dedup_case_insensitive(self):
        relaxed = mod._relax_query('Dropper dropper browse repo:acme/app')
        # 'Dropper'/'dropper' collapse to one term; two distinct terms remain
        assert relaxed == 'Dropper OR browse repo:acme/app'

    def test_max_terms_respected(self):
        relaxed = mod._relax_query('alpha beta gamma delta epsilon zeta eta', max_terms=3)
        or_clause = relaxed
        assert or_clause == 'alpha OR beta OR gamma'

    def test_quoted_qualifier_value_stays_atomic(self):
        # The space inside label:"good first issue" must not split the qualifier.
        relaxed = mod._relax_query('dropper browse label:"good first issue"')
        assert relaxed == 'dropper OR browse label:"good first issue"'

    def test_negated_qualifier_preserved_as_filter(self):
        # -label:bug is a filter, not a free-text term, so it must not join the OR clause.
        relaxed = mod._relax_query('dropper browse -label:bug')
        assert relaxed == 'dropper OR browse -label:bug'

    def test_quoted_phrase_term_kept_quoted(self):
        relaxed = mod._relax_query('"browse button" dropper repo:acme/app')
        assert relaxed == '"browse button" OR dropper repo:acme/app'

    def test_keyword_count_trimmed_to_leave_room_for_qualifiers(self):
        # 5 keywords + 3 qualifiers would exceed GitHub's 5 AND/OR/NOT operator limit;
        # the keyword count is trimmed so (OR ops) + (qualifiers) stays within budget.
        relaxed = mod._relax_query('alpha beta gamma delta epsilon repo:a/b is:open in:title')
        or_clause = relaxed.split(' repo:')[0]
        assert or_clause == 'alpha OR beta OR gamma'  # 6 - 3 qualifiers = 3 keywords


# ---------------------------------------------------------------------------
# Fallback wiring in search_issues / search_code
# ---------------------------------------------------------------------------


class _Cfg:
    def __init__(self, token='tok', default_repo='', read_only=False):
        self.token = token
        self.default_repo = default_repo
        self.read_only = read_only


def _make_instance(cfg=None):
    inst = mod.IInstance()
    inst.IGlobal = cfg or _Cfg()
    return inst


def _queue_calls(monkeypatch, responses):
    """Patch mod.call to return queued responses in order, recording each query."""
    calls = []
    seq = list(responses)

    def _fake(token, method, path, *, params=None, body=None, **kwargs):
        calls.append({'path': path, 'q': (params or {}).get('q')})
        return seq.pop(0)

    monkeypatch.setattr(mod, 'call', _fake)
    return calls


_ISSUE_ITEM = {
    'number': 1335,
    'title': 'Dropper Browse files button not responding',
    'repository_url': 'https://api.github.com/repos/acme/app',
}


class TestSearchIssuesFallback:
    def test_empty_first_pass_retries_with_relaxed_query(self, monkeypatch):
        calls = _queue_calls(monkeypatch, [{'items': []}, {'items': [_ISSUE_ITEM]}])
        inst = _make_instance(_Cfg(default_repo='acme/app'))
        out = inst.search_issues({'query': _VERBOSE})
        assert len(calls) == 2
        assert ' OR ' in calls[1]['q']  # second pass used the relaxed query
        assert calls[1]['q'] != calls[0]['q']
        assert out and out[0]['number'] == 1335

    def test_non_empty_first_pass_does_not_retry(self, monkeypatch):
        calls = _queue_calls(monkeypatch, [{'items': [_ISSUE_ITEM]}])
        inst = _make_instance(_Cfg(default_repo='acme/app'))
        out = inst.search_issues({'query': 'dropper browse'})
        assert len(calls) == 1
        assert out and out[0]['number'] == 1335

    def test_unrelaxable_empty_query_does_not_retry(self, monkeypatch):
        # single keyword -> _relax_query returns None -> no second call
        calls = _queue_calls(monkeypatch, [{'items': []}])
        inst = _make_instance(_Cfg(default_repo='acme/app'))
        out = inst.search_issues({'query': 'dropper'})
        assert len(calls) == 1
        assert out == []


class TestSearchCodeFallback:
    def test_empty_first_pass_retries_with_relaxed_query(self, monkeypatch):
        code_item = {
            'name': 'd.tsx',
            'path': 'src/d.tsx',
            'repository': {'full_name': 'acme/app'},
            'html_url': 'http://x',
        }
        calls = _queue_calls(monkeypatch, [{'items': []}, {'items': [code_item]}])
        inst = _make_instance(_Cfg(default_repo='acme/app'))
        out = inst.search_code({'query': _VERBOSE})
        assert len(calls) == 2
        assert ' OR ' in calls[1]['q']
        assert out and out[0]['path'] == 'src/d.tsx'
