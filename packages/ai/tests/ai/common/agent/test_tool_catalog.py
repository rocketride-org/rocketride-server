"""Compact tool catalogs and the selection rules of tools.load (ai.common.agent.tool_catalog).

The module uses the standard library only, so it is loaded from its file and the
tests run in a plain interpreter as well as in the engine's.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[4] / 'src' / 'ai' / 'common' / 'agent' / 'tool_catalog.py'
_spec = importlib.util.spec_from_file_location('_rr_tool_catalog_under_test', _PATH)
tc = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = tc
_spec.loader.exec_module(tc)


def _td(name, description='', **props):
    schema = {'type': 'object', 'properties': {k: {'type': v} for k, v in props.items()}}
    return {'name': name, 'description': description, 'inputSchema': schema}


def _planner_serialization(descriptors):
    """A copy of what the Wave planner writes for the Available Tools block (planner._build_all_tool_descriptions)."""
    return '\n'.join(json.dumps(td, ensure_ascii=False) for td in descriptors)


def test_catalog_text_matches_the_eager_serialization_for_dict_descriptors():
    tools = [_td('a.read', 'Read a.', id='string'), _td('b.write', 'Écrit b.'), _td('c.list', '日本語')]

    assert tc.catalog_text(tools) == _planner_serialization(tools)
    assert tc.catalog_chars(tools) == len(_planner_serialization(tools))
    assert tc.catalog_text([*tools, {'description': 'no name'}, {'name': ''}]) == _planner_serialization(tools)
    assert tc.catalog_text([]) == ''
    assert tc.catalog_chars([]) == 0


def test_summary_is_one_line_first_sentence_cut_at_160():
    assert tc.summarize('Read one record.') == 'Read one record.'
    assert tc.summarize('Read one record. It also logs.') == 'Read one record.'
    assert tc.summarize('Read  one\nrecord\tby id') == 'Read one record by id'
    long = 'x' * 300
    assert tc.summarize(long) == 'x' * 157 + '...'
    assert len(tc.summarize(long)) == 160
    assert tc.summarize(None) == ''
    assert tc.summarize(42) == ''


def test_catalog_lines_keep_order_and_format():
    tools = [_td('a', 'A.'), _td('b', 'B.'), _td('c')]

    assert tc.catalog_lines(tools) == ['- a: A.', '- b: B.', '- c']


def test_search_ranks_name_hits_above_description_hits():
    tools = [_td('mail.send', 'Send an invoice by mail.'), _td('billing.get_invoice', 'Read one.')]

    assert [td['name'] for td in tc.search(tools, 'invoice', 5)] == ['billing.get_invoice', 'mail.send']


def test_search_splits_snake_and_camel_case_and_dots():
    tools = [_td('srv.getInvoiceById', 'Read one.'), _td('srv.other', 'Other.')]

    assert [td['name'] for td in tc.search(tools, 'invoice id', 5)] == ['srv.getInvoiceById']


def test_search_matches_argument_names():
    tools = [_td('crm.lookup', 'Find a record.', customer_id='string'), _td('crm.other', 'Other.')]

    assert [td['name'] for td in tc.search(tools, 'customer', 5)] == ['crm.lookup']


def test_search_respects_limit_and_returns_nothing_for_no_match():
    tools = [_td(f'x.read_{i}', 'Read.') for i in range(5)]

    assert [td['name'] for td in tc.search(tools, 'read', 2)] == ['x.read_0', 'x.read_1']
    assert tc.search(tools, 'weather', 5) == []
    assert tc.search(tools, '  ', 5) == []


def _abc():
    """Three tools a query for 'deal' matches in order a, b, c, and one it does not match."""
    return [
        _td('crm.a_deal', 'Deal record.'),
        _td('crm.b_deal', 'Deal list.'),
        _td('crm.c_deal', 'Deal history.'),
        _td('crm.zzz', 'Unrelated.'),
    ]


def _names(found):
    return [td['name'] for td in found]


def test_select_names_first_then_query_adds_up_to_limit():
    found, unknown, ignored = tc.select(_abc(), names=['crm.b_deal'], query='deal', limit=2)

    assert _names(found) == ['crm.b_deal', 'crm.a_deal', 'crm.c_deal']
    assert unknown == [] and ignored == []


def test_select_deduplicates_names_and_limit_counts_only_query_additions():
    found, _, _ = tc.select(_abc(), names=['crm.b_deal', 'crm.b_deal', 'crm.a_deal'], query='deal', limit=1)

    assert _names(found) == ['crm.b_deal', 'crm.a_deal', 'crm.c_deal']


def test_select_considers_at_most_20_names():
    tools = [_td(f'x.t{i:02d}', 'Tool.') for i in range(30)]
    names = [td['name'] for td in tools[:25]]

    found, unknown, ignored = tc.select(tools, names=names)

    assert _names(found) == names[:20]
    assert ignored == names[20:]
    assert unknown == []


def test_select_unknown_name_uses_lookup_once_then_reports_unknown():
    calls = []

    def lookup(name):
        calls.append(name)
        if name == 'late':
            return _td('late', 'Appeared after a refresh.')
        raise LookupError(name)

    found, unknown, ignored = tc.select(_abc(), names=['late', 'ghost'], query='deal', limit=1, lookup=lookup)

    assert _names(found) == ['late', 'crm.a_deal']
    assert unknown == ['ghost']
    assert ignored == []
    assert calls == ['late', 'ghost']


def test_tool_view_shows_only_loaded_names_that_are_in_the_catalog():
    class Obj:
        name = 'obj'

    a, b = _td('a', 'A.'), _td('b', 'B.')
    view = tc.tool_view([a, b, Obj(), {'name': ''}], {'a', 'gone'})

    assert view.catalog == (a, b)
    assert view.loaded == (a,)
    assert view.shown == frozenset({'a'})


@pytest.mark.parametrize('limit', [0, -3, 99])
def test_select_clamps_the_query_limit(limit):
    tools = [_td(f'x.deal_{i:02d}', 'Deal.') for i in range(30)]

    found, _, _ = tc.select(tools, query='deal', limit=limit)

    assert len(found) == (1 if limit < 1 else 20)
