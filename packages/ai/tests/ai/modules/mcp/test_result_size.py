# Copyright 2026 Aparavi Software AG. MIT License.
"""The result size limit: `fit` and its steps, the envelope, and the setting."""

import logging

import pytest

from ai.modules.mcp import result_size
from ai.modules.mcp import tools as tools_pkg
from ai.modules.mcp.result_size import drop, fit, page_budget, rows, size_of, take_rows, text
from ai.modules.mcp.tooling import ToolRegistry


def test_fit_changes_nothing_that_fits_or_when_the_limit_is_off(result_limit):
    result_limit(1000)
    small = {'ok': True, 'rows': [1, 2, 3]}
    fit(small, [rows('rows')])
    result_limit(0)
    large = {'ok': True, 'rows': ['x' * 100] * 100}
    fit(large, [rows('rows')])
    assert (small, large) == ({'ok': True, 'rows': [1, 2, 3]}, {'ok': True, 'rows': ['x' * 100] * 100})


@pytest.mark.parametrize('output', ['a' * 5000, '"' * 5000, '\\' * 5000, '\u4e2d' * 5000])
def test_text_keeps_the_longest_lead_that_fits(result_limit, output):
    result_limit(1000)
    payload = {'ok': True, 'task_token': 'tk_1', 'result': output}
    fit(payload, [text('result')], hint='Read on.')
    kept = payload['result']
    assert (size_of(payload) <= 1000, payload['task_token'], output.startswith(kept)) == (True, 'tk_1', True)
    assert payload['truncated'] == {'result': {'returned_chars': len(kept), 'total_chars': 5000}, 'hint': 'Read on.'}
    # One more character would not fit.
    assert size_of({**payload, 'result': output[: len(kept) + 1]}) > 1000


def test_text_with_a_cap_cuts_once_and_drop_writes_the_empty_value(result_limit):
    result_limit(1000)
    payload = {'ok': True, 'error': 'e' * 5000, 'section': {'ui': {'layout': 'x' * 5000}, 'schema': {}}}
    fit(payload, [text('error', cap=300), drop(('section', 'ui'), {})])

    assert payload['error'] == 'e' * 300
    assert payload['section'] == {'ui': {}, 'schema': {}}
    assert payload['truncated'] == {
        'error': {'returned_chars': 300, 'total_chars': 5000},
        'section.ui': {'dropped': True},
    }


def test_keep_nulls_every_other_key_when_the_steps_are_not_enough(result_limit):
    result_limit(1000)
    payload = {'ok': True, 'task_token': 'tk_1', 'projectId': 'p' * 5000, 'source': 's', 'result': 'r' * 5000}
    fit(payload, [text('result')], hint='H', keep=('ok', 'task_token'))

    assert payload == {
        'ok': True,
        'task_token': 'tk_1',
        'projectId': None,
        'source': None,
        'result': None,
        'truncated': {'dropped': ['projectId', 'source', 'result'], 'hint': 'H'},
    }
    assert size_of(payload) < 1000


def test_the_envelope_fits_the_smallest_limit_for_every_tool(result_limit):
    result_limit(result_size.MIN_MAX_CHARS)
    registry = ToolRegistry(local_engine=True)
    tools_pkg.register_all(registry)
    for name in [*registry.names(), None]:
        envelope = result_size.too_large(name, 10**12)
        assert envelope['ok'] is False
        assert envelope['error_type'] == 'ResultTooLarge'
        assert size_of(envelope) < result_size.MIN_MAX_CHARS


@pytest.mark.parametrize(
    'raw, expected, warns',
    [
        (None, 40000, False),
        ('0', 0, False),
        ('80000', 80000, False),
        ('999', 40000, True),
        ('-1', 40000, True),
        ('1.5', 40000, True),
    ],
)
def test_the_setting(caplog, raw, expected, warns):
    with caplog.at_level(logging.WARNING, logger='ai.modules.mcp.result_size'):
        assert result_size.parse(raw) == expected
    messages = [record.getMessage() for record in caplog.records]
    assert len(messages) == int(warns)
    if warns:
        assert 'MCP_RESULT_MAX_CHARS' in messages[0]
        assert raw not in messages[0]


@pytest.mark.parametrize(
    'offset, limit, budget, expected',
    [
        (0, None, None, (20, None)),
        # Ten rows of 10 characters are 100, but with the separators only 8 fit.
        (0, None, 100, (8, 8)),
        (2, 3, None, (3, 5)),
        (18, None, 100, (2, None)),
        (25, None, 100, (0, None)),
    ],
)
def test_take_rows(offset, limit, budget, expected):
    all_rows = [f'{i:08d}' for i in range(20)]
    page, next_offset = take_rows(all_rows, offset, limit, budget)
    assert (len(page), next_offset) == expected
    assert page == all_rows[offset : offset + len(page)]


def test_take_rows_always_returns_a_row_and_the_budget_is_three_quarters(result_limit):
    assert take_rows(['x' * 500, 'y'], 0, None, 100) == (['x' * 500], 1)
    result_limit(1000)
    assert page_budget() == 750
    result_limit(0)
    assert page_budget() is None
