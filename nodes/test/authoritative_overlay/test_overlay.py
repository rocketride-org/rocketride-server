# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Network-free unit tests for the authoritative_overlay node.

Covers number normalization, period-scoped SEC matching, CIK handling, and the
writeAnswers emit contract (match returns normally; abstain calls preventDefault).
"""

from __future__ import annotations

import json
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'src' / 'nodes'))

_STUB_MODULE_NAMES = (
    'rocketlib',
    'ai',
    'ai.common',
    'ai.common.schema',
    'ai.common.config',
)


def _install_stubs() -> None:
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.debug = lambda *_a, **_k: None
    rocketlib.warning = lambda *_a, **_k: None
    sys.modules['rocketlib'] = rocketlib

    sys.modules['ai'] = types.ModuleType('ai')
    sys.modules['ai.common'] = types.ModuleType('ai.common')

    schema = types.ModuleType('ai.common.schema')
    schema.Answer = type('Answer', (), {})
    sys.modules['ai.common.schema'] = schema

    config = types.ModuleType('ai.common.config')
    config.Config = type('Config', (), {'getNodeConfig': staticmethod(lambda *_a, **_k: {})})
    sys.modules['ai.common.config'] = config


@contextmanager
def _scoped_stubs() -> Iterator[None]:
    original = {name: sys.modules.get(name) for name in _STUB_MODULE_NAMES}
    _install_stubs()
    try:
        yield
    finally:
        for name, module in original.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


with _scoped_stubs():
    from authoritative_overlay.IGlobal import IGlobal
    from authoritative_overlay.IInstance import IInstance, _normalize_number
    from authoritative_overlay.connectors.sec import query_sec, select_official_values


# --- _normalize_number -------------------------------------------------------


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [
        ('$1,234.56', 1234.56),
        ('€1,000', 1000.0),
        ('(1.5m)', -1_500_000.0),
        ('(1.5)', -1.5),
        ('2.5k', 2500.0),
        ('3b', 3_000_000_000.0),
        ('1.5 in thousands', 1500.0),
        ('2 in millions', 2_000_000.0),
        ('1 in billions', 1_000_000_000.0),
        ('  42  ', 42.0),
    ],
)
def test_normalize_number_branches(raw, expected):
    assert _normalize_number(raw) == expected


def test_normalize_number_junk_returns_none():
    assert _normalize_number('not-a-number') is None
    assert _normalize_number('n/a') is None


# --- select_official_values (period scope) -----------------------------------


_UNITS = {
    'USD': [
        {'end': '2010-09-25', 'val': 5520000000, 'fy': 2010, 'fp': 'FY', 'form': '10-K'},
        {'end': '2024-09-28', 'val': 68960000000, 'fy': 2024, 'fp': 'FY', 'form': '10-K'},
        {'end': '2025-09-27', 'val': 69860000000, 'fy': 2025, 'fp': 'FY', 'form': '10-K'},
        {'end': '2025-03-29', 'val': 74362000000, 'fy': 2025, 'fp': 'Q2', 'form': '10-Q'},
    ]
}


def test_select_requires_a_period_filter():
    # Unscoped lookup would accept any historical value; fail closed instead.
    assert select_official_values(_UNITS, None) == []
    assert select_official_values(_UNITS, {}) == []


def test_select_scopes_to_form_and_fy():
    values = select_official_values(_UNITS, {'form': '10-K', 'fy': 2025})
    assert values == [69860000000.0]


def test_select_does_not_match_other_years():
    values = select_official_values(_UNITS, {'form': '10-K', 'fy': 2025})
    assert 5520000000.0 not in values
    assert 68960000000.0 not in values
    assert 74362000000.0 not in values


def test_select_form_disambiguates_10q_from_10k():
    values = select_official_values(_UNITS, {'form': '10-Q', 'fy': 2025})
    assert values == [74362000000.0]


def test_select_end_date():
    values = select_official_values(_UNITS, {'end': '2024-09-28'})
    assert values == [68960000000.0]


def test_select_unit_filter():
    mixed = {
        'USD': [{'val': 10, 'form': '10-K', 'fy': 2025}],
        'shares': [{'val': 99, 'form': '10-K', 'fy': 2025}],
    }
    assert select_official_values(mixed, {'form': '10-K', 'fy': 2025, 'unit': 'USD'}) == [10.0]


# --- query_sec ---------------------------------------------------------------


def test_query_sec_blank_cik_does_not_hit_network():
    with patch('authoritative_overlay.connectors.sec.requests.get') as get:
        assert query_sec('Revenues', '', {'form': '10-K', 'fy': 2025}) is None
        get.assert_not_called()


def test_query_sec_applies_filters_to_response():
    body = {'units': _UNITS}
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = body
    response.raise_for_status.return_value = None
    with patch('authoritative_overlay.connectors.sec.requests.get', return_value=response) as get:
        values = query_sec('AccountsPayableCurrent', '0000320193', {'form': '10-K', 'fy': 2025})
    assert values == [69860000000.0]
    assert 'User-Agent' in get.call_args.kwargs['headers']
    assert 'support@rocketride.org' in get.call_args.kwargs['headers']['User-Agent']


# --- IInstance.writeAnswers contract -----------------------------------------


class _PreventDefault(Exception):
    pass


def _make_instance(regulator='sec', cik='0000320193'):
    inst = IInstance()
    inst.IGlobal = MagicMock()
    inst.IGlobal.regulator_type = regulator
    inst.IGlobal.cik = cik
    inst.instance = MagicMock()
    inst.preventDefault = MagicMock(side_effect=_PreventDefault)
    return inst


def _answer(payload: dict):
    answer = MagicMock()
    answer.isJson.return_value = True
    answer.getJson.return_value = payload
    answer.getText.return_value = json.dumps(payload)
    return answer


def test_write_answers_match_does_not_emit_explicitly():
    """Returning normally lets the engine forward once. An extra writeAnswers is a double-emit."""
    inst = _make_instance()
    payload = {
        'concept': 'AccountsPayableCurrent',
        'value': '$69,860,000,000',
        'form': '10-K',
        'fy': 2025,
    }
    with patch('authoritative_overlay.IInstance.query_sec', return_value=[69860000000.0]):
        inst.writeAnswers(_answer(payload))
    inst.instance.writeAnswers.assert_not_called()
    inst.preventDefault.assert_not_called()


def test_write_answers_mismatch_abstains():
    inst = _make_instance()
    payload = {
        'concept': 'AccountsPayableCurrent',
        'value': '$999,000',
        'form': '10-K',
        'fy': 2025,
    }
    with patch('authoritative_overlay.IInstance.query_sec', return_value=[69860000000.0]):
        with pytest.raises(_PreventDefault):
            inst.writeAnswers(_answer(payload))
    inst.instance.writeAnswers.assert_not_called()


def test_write_answers_without_period_abstains():
    inst = _make_instance()
    payload = {'concept': 'AccountsPayableCurrent', 'value': '$69,860,000,000'}
    with patch('authoritative_overlay.IInstance.query_sec') as query:
        with pytest.raises(_PreventDefault):
            inst.writeAnswers(_answer(payload))
    query.assert_not_called()


def test_write_answers_unknown_regulator_does_not_look_like_connector_error():
    inst = _make_instance(regulator='ifrs')
    payload = {
        'concept': 'AccountsPayableCurrent',
        'value': '$69,860,000,000',
        'form': '10-K',
        'fy': 2025,
    }
    with patch('authoritative_overlay.IInstance.query_sec') as query:
        with pytest.raises(_PreventDefault):
            inst.writeAnswers(_answer(payload))
    query.assert_not_called()


def test_write_answers_historical_value_wrong_year_abstains():
    inst = _make_instance()
    # 2010 10-K value must not verify a FY2025 claim.
    payload = {
        'concept': 'AccountsPayableCurrent',
        'value': '$5,520,000,000',
        'form': '10-K',
        'fy': 2025,
    }
    with patch('authoritative_overlay.IInstance.query_sec', return_value=[69860000000.0]):
        with pytest.raises(_PreventDefault):
            inst.writeAnswers(_answer(payload))


# --- IGlobal CIK padding -----------------------------------------------------


def test_blank_cik_is_not_zero_padded_to_truthy():
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.regulator_type = 'sec'
    iglobal.cik = ''
    iglobal.glb = MagicMock()
    iglobal.glb.logicalType = 'authoritative_overlay'
    iglobal.glb.connConfig = {}

    with patch(
        'authoritative_overlay.IGlobal.Config.getNodeConfig',
        return_value={'regulator_type': 'sec', 'cik': ''},
    ):
        IGlobal.beginGlobal(iglobal)
    assert iglobal.cik == ''


def test_numeric_cik_is_zero_padded():
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.regulator_type = 'sec'
    iglobal.cik = ''
    iglobal.glb = MagicMock()
    iglobal.glb.logicalType = 'authoritative_overlay'
    iglobal.glb.connConfig = {}

    with patch(
        'authoritative_overlay.IGlobal.Config.getNodeConfig',
        return_value={'regulator_type': 'sec', 'cik': '320193'},
    ):
        IGlobal.beginGlobal(iglobal)
    assert iglobal.cik == '0000320193'
