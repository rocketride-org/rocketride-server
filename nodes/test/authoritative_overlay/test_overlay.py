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
import importlib
import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
import requests

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
    _iglobal_module = importlib.import_module('authoritative_overlay.IGlobal')
    _iinstance_module = importlib.import_module('authoritative_overlay.IInstance')
    from authoritative_overlay.IGlobal import IGlobal
    from authoritative_overlay.IInstance import IInstance, _normalize_number
    from authoritative_overlay.connectors.sec import PERIOD_SCOPE_KEYS, query_sec, select_official_values


def test_services_description_lists_every_supported_period_selector():
    """Keep the operator-facing selector list aligned with connector behavior."""
    service_path = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'authoritative_overlay' / 'services.json'
    description = ' '.join(json.loads(service_path.read_text())['description'])
    assert f'({" / ".join(PERIOD_SCOPE_KEYS)})' in description


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
        {
            'end': '2010-09-25',
            'val': 5520000000,
            'accn': 'annual-2010',
            'fy': 2010,
            'fp': 'FY',
            'form': '10-K',
        },
        {
            'end': '2024-09-28',
            'val': 68960000000,
            'accn': 'annual-2024',
            'fy': 2024,
            'fp': 'FY',
            'form': '10-K',
        },
        {
            'end': '2025-09-27',
            'val': 69860000000,
            'accn': 'annual-2025',
            'fy': 2025,
            'fp': 'FY',
            'form': '10-K',
        },
        {
            'end': '2025-03-29',
            'val': 74362000000,
            'accn': 'quarter-2025-q2',
            'fy': 2025,
            'fp': 'Q2',
            'form': '10-Q',
        },
    ]
}
_REPORT_DATES = {
    'annual-2010': '2010-09-25',
    'annual-2024': '2024-09-28',
    'annual-2025': '2025-09-27',
    'quarter-2025-q2': '2025-03-29',
}


def test_select_requires_a_period_filter():
    # Unscoped lookup would accept any historical value; fail closed instead.
    assert select_official_values(_UNITS, None) == []
    assert select_official_values(_UNITS, {}) == []
    assert select_official_values(_UNITS, {'unit': 'USD'}) == []


def test_select_scopes_to_form_and_fy():
    assert select_official_values(_UNITS, {'form': '10-K', 'fy': 2025}) == []
    values = select_official_values(_UNITS, {'form': '10-K', 'fy': 2025}, _REPORT_DATES)
    assert values == [69860000000.0]


def test_select_does_not_match_other_years():
    values = select_official_values(_UNITS, {'form': '10-K', 'fy': 2025}, _REPORT_DATES)
    assert 5520000000.0 not in values
    assert 68960000000.0 not in values
    assert 74362000000.0 not in values


def test_select_form_disambiguates_10q_from_10k():
    values = select_official_values(_UNITS, {'form': '10-Q', 'fy': 2025}, _REPORT_DATES)
    assert values == [74362000000.0]


def test_select_end_date():
    values = select_official_values(_UNITS, {'end': '2024-09-28'})
    assert values == [68960000000.0]


def test_select_unit_filter():
    mixed = {
        'USD': [{'end': '2025-12-31', 'val': 10, 'form': '10-K', 'fy': 2025}],
        'shares': [{'end': '2025-12-31', 'val': 99, 'form': '10-K', 'fy': 2025}],
    }
    assert select_official_values(mixed, {'end': '2025-12-31', 'unit': 'USD'}) == [10.0]


@pytest.mark.parametrize(
    ('measurements', 'filters'),
    [
        (
            [
                {'end': '2025-12-31', 'val': 100, 'accn': 'original'},
                {'end': '2025-12-31', 'val': 120, 'accn': 'restated'},
            ],
            {'end': '2025-12-31'},
        ),
        (
            [
                {
                    'start': '2025-01-01',
                    'end': '2025-03-31',
                    'frame': 'CY2025Q1',
                    'val': 100,
                    'accn': 'original',
                },
                {
                    'start': '2025-01-01',
                    'end': '2025-03-31',
                    'frame': 'CY2025Q1',
                    'val': 120,
                    'accn': 'restated',
                },
            ],
            {'frame': 'CY2025Q1'},
        ),
    ],
)
def test_select_abstains_from_conflicting_values_for_same_period(measurements, filters):
    """Never choose between conflicting original and restated filing values."""
    assert select_official_values({'USD': measurements}, filters) == []


def test_select_implicit_period_abstains_from_conflicting_values():
    measurements = [
        {
            'start': '2025-01-01',
            'end': '2025-12-31',
            'val': 100,
            'accn': 'original',
            'fy': 2025,
            'fp': 'FY',
            'form': '10-K',
        },
        {
            'start': '2025-01-01',
            'end': '2025-12-31',
            'val': 120,
            'accn': 'restated',
            'fy': 2025,
            'fp': 'FY',
            'form': '10-K',
        },
    ]
    report_dates = {'original': '2025-12-31', 'restated': '2025-12-31'}

    assert (
        select_official_values(
            {'USD': measurements},
            {'form': '10-K', 'fy': 2025, 'fp': 'FY'},
            report_dates,
        )
        == []
    )


def test_select_allows_equal_duplicate_values_for_same_period():
    measurements = [
        {'end': '2025-12-31', 'val': 100, 'accn': 'first'},
        {'end': '2025-12-31', 'val': 100.0, 'accn': 'second'},
    ]

    assert select_official_values({'USD': measurements}, {'end': '2025-12-31'}) == [100.0, 100.0]


def test_select_explicit_filter_can_exclude_conflicting_filing():
    measurements = [
        {'end': '2025-12-31', 'val': 100, 'accn': 'annual', 'form': '10-K'},
        {'end': '2025-12-31', 'val': 120, 'accn': 'quarterly', 'form': '10-Q'},
    ]

    assert select_official_values(
        {'USD': measurements},
        {'end': '2025-12-31', 'form': '10-K'},
    ) == [100.0]


# --- query_sec ---------------------------------------------------------------


def test_query_sec_blank_cik_does_not_hit_network():
    with patch('authoritative_overlay.connectors.sec.requests.get') as get:
        assert query_sec('Revenues', '', {'form': '10-K', 'fy': 2025}) is None
        get.assert_not_called()


def test_query_sec_unit_without_period_does_not_hit_network():
    with patch('authoritative_overlay.connectors.sec.requests.get') as get:
        assert query_sec('Revenues', '0000320193', {'unit': 'USD'}) == []
        get.assert_not_called()


def test_query_sec_applies_filters_to_response():
    body = {'units': _UNITS}
    response = MagicMock()
    response.status_code = 200
    response.json.return_value = body
    response.raise_for_status.return_value = None
    with patch('authoritative_overlay.connectors.sec.requests.get', return_value=response) as get:
        values = query_sec(
            'AccountsPayableCurrent',
            '0000320193',
            {'form': '10-K', 'fy': 2025, 'end': '2025-09-27'},
        )
    assert values == [69860000000.0]
    assert 'User-Agent' in get.call_args.kwargs['headers']
    assert 'support@rocketride.org' in get.call_args.kwargs['headers']['User-Agent']


def test_query_sec_uses_filing_report_date_to_exclude_comparative_fact():
    concept_response = MagicMock()
    concept_response.status_code = 200
    concept_response.raise_for_status.return_value = None
    concept_response.json.return_value = {
        'units': {
            'USD': [
                {
                    'end': '2024-09-28',
                    'val': 68960000000,
                    'accn': '0000320193-25-000079',
                    'fy': 2025,
                    'fp': 'FY',
                    'form': '10-K',
                    'filed': '2025-10-31',
                    'frame': 'CY2024Q3I',
                },
                {
                    'end': '2025-09-27',
                    'val': 69860000000,
                    'accn': '0000320193-25-000079',
                    'fy': 2025,
                    'fp': 'FY',
                    'form': '10-K',
                    'filed': '2025-10-31',
                },
            ]
        }
    }
    submissions_response = MagicMock()
    submissions_response.status_code = 200
    submissions_response.raise_for_status.return_value = None
    submissions_response.json.return_value = {
        'filings': {
            'recent': {
                'accessionNumber': ['0000320193-25-000079'],
                'reportDate': ['2025-09-27'],
            },
            'files': [],
        }
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[concept_response, submissions_response],
    ) as get:
        values = query_sec(
            'AccountsPayableCurrent',
            '0000320193',
            {'form': '10-K', 'fy': 2025, 'unit': 'USD'},
        )

    assert values == [69860000000.0]
    assert get.call_count == 2
    assert '/submissions/CIK0000320193.json' in get.call_args_list[1].args[0]


def test_query_sec_scopes_duration_facts_to_filing_report_date():
    concept_response = MagicMock()
    concept_response.status_code = 200
    concept_response.raise_for_status.return_value = None
    concept_response.json.return_value = {
        'units': {
            'USD': [
                {
                    'start': '2022-09-25',
                    'end': '2023-09-30',
                    'val': 383285000000,
                    'accn': '0000320193-25-000079',
                    'fy': 2025,
                    'fp': 'FY',
                    'form': '10-K',
                },
                {
                    'start': '2023-10-01',
                    'end': '2024-09-28',
                    'val': 391035000000,
                    'accn': '0000320193-25-000079',
                    'fy': 2025,
                    'fp': 'FY',
                    'form': '10-K',
                },
                {
                    'start': '2024-09-29',
                    'end': '2025-09-27',
                    'val': 416161000000,
                    'accn': '0000320193-25-000079',
                    'fy': 2025,
                    'fp': 'FY',
                    'form': '10-K',
                },
            ]
        }
    }
    submissions_response = MagicMock()
    submissions_response.status_code = 200
    submissions_response.raise_for_status.return_value = None
    submissions_response.json.return_value = {
        'filings': {
            'recent': {
                'accessionNumber': ['0000320193-25-000079'],
                'reportDate': ['2025-09-27'],
            },
            'files': [],
        }
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[concept_response, submissions_response],
    ):
        values = query_sec(
            'RevenueFromContractWithCustomerExcludingAssessedTax',
            '0000320194',
            {'form': '10-K', 'fy': 2025, 'fp': 'FY', 'unit': 'USD'},
        )

    assert values == [416161000000.0]


def test_select_abstains_when_same_report_date_has_multiple_durations():
    units = {
        'USD': [
            {
                'start': '2024-09-29',
                'end': '2025-03-29',
                'val': 219659000000,
                'accn': 'quarterly-filing',
                'fy': 2025,
                'fp': 'Q2',
                'form': '10-Q',
            },
            {
                'start': '2024-12-29',
                'end': '2025-03-29',
                'val': 95359000000,
                'accn': 'quarterly-filing',
                'fy': 2025,
                'fp': 'Q2',
                'form': '10-Q',
            },
        ]
    }
    filters = {'form': '10-Q', 'fy': 2025, 'fp': 'Q2', 'unit': 'USD'}

    assert select_official_values(units, filters, {'quarterly-filing': '2025-03-29'}) == []


def test_select_start_date_disambiguates_duration():
    units = {
        'USD': [
            {
                'start': '2024-09-29',
                'end': '2025-03-29',
                'val': 219659000000,
                'accn': 'quarterly-filing-explicit',
                'fy': 2025,
                'fp': 'Q2',
                'form': '10-Q',
            },
            {
                'start': '2024-12-29',
                'end': '2025-03-29',
                'val': 95359000000,
                'accn': 'quarterly-filing-explicit',
                'fy': 2025,
                'fp': 'Q2',
                'form': '10-Q',
            },
        ]
    }
    filters = {
        'form': '10-Q',
        'fy': 2025,
        'fp': 'Q2',
        'start': '2024-12-29',
        'unit': 'USD',
    }

    assert select_official_values(
        units,
        filters,
        {'quarterly-filing-explicit': '2025-03-29'},
    ) == [95359000000.0]


def test_query_sec_abstains_when_filters_span_multiple_report_dates():
    concept_response = MagicMock()
    concept_response.status_code = 200
    concept_response.raise_for_status.return_value = None
    concept_response.json.return_value = {
        'units': {
            'USD': [
                {'end': '2024-12-31', 'val': 1, 'accn': 'first', 'fy': 2025, 'form': '10-K'},
                {'end': '2025-12-31', 'val': 2, 'accn': 'second', 'fy': 2025, 'form': '10-K'},
            ]
        }
    }
    submissions_response = MagicMock()
    submissions_response.status_code = 200
    submissions_response.raise_for_status.return_value = None
    submissions_response.json.return_value = {
        'filings': {
            'recent': {
                'accessionNumber': ['first', 'second'],
                'reportDate': ['2024-12-31', '2025-12-31'],
            },
            'files': [],
        }
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[concept_response, submissions_response],
    ):
        values = query_sec('Revenue', '0000320195', {'form': '10-K', 'fy': 2025, 'unit': 'USD'})

    assert values == []


def test_query_sec_fails_closed_when_matching_fact_has_no_accession():
    response = MagicMock()
    response.status_code = 200
    response.raise_for_status.return_value = None
    response.json.return_value = {'units': {'USD': [{'end': '2025-12-31', 'val': 2, 'fy': 2025, 'form': '10-K'}]}}
    with patch('authoritative_overlay.connectors.sec.requests.get', return_value=response) as get:
        values = query_sec('Revenue', '0000320196', {'form': '10-K', 'fy': 2025, 'unit': 'USD'})
    assert values == []
    assert get.call_count == 1


def test_query_sec_no_matching_fact_does_not_fetch_submission_index():
    response = MagicMock()
    response.status_code = 200
    response.raise_for_status.return_value = None
    response.json.return_value = {
        'units': {'USD': [{'end': '2024-12-31', 'val': 1, 'accn': 'older', 'fy': 2024, 'form': '10-K'}]}
    }
    with patch('authoritative_overlay.connectors.sec.requests.get', return_value=response) as get:
        values = query_sec('Revenue', '0000320196', {'form': '10-K', 'fy': 2025, 'unit': 'USD'})
    assert values == []
    assert get.call_count == 1


def test_query_sec_submission_failure_returns_none():
    concept_response = MagicMock()
    concept_response.status_code = 200
    concept_response.raise_for_status.return_value = None
    concept_response.json.return_value = {
        'units': {'USD': [{'end': '2025-12-31', 'val': 2, 'accn': 'first', 'fy': 2025, 'form': '10-K'}]}
    }
    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[concept_response, requests.exceptions.Timeout('timed out')],
    ):
        values = query_sec('Revenue', '0000320197', {'form': '10-K', 'fy': 2025, 'unit': 'USD'})
    assert values is None


def test_query_sec_resolves_report_date_from_historical_submission_file():
    concept_response = MagicMock()
    concept_response.status_code = 200
    concept_response.raise_for_status.return_value = None
    concept_response.json.return_value = {
        'units': {
            'USD': [
                {
                    'end': '2010-09-25',
                    'val': 5520000000,
                    'accn': 'historical-accession',
                    'fy': 2010,
                    'form': '10-K',
                }
            ]
        }
    }
    index_response = MagicMock()
    index_response.status_code = 200
    index_response.raise_for_status.return_value = None
    index_response.json.return_value = {
        'filings': {
            'recent': {'accessionNumber': [], 'reportDate': []},
            'files': [{'name': 'CIK0000320198-submissions-001.json'}],
        }
    }
    historical_response = MagicMock()
    historical_response.status_code = 200
    historical_response.raise_for_status.return_value = None
    historical_response.json.return_value = {
        'accessionNumber': ['historical-accession'],
        'reportDate': ['2010-09-25'],
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[concept_response, index_response, historical_response],
    ) as get:
        values = query_sec(
            'AccountsPayableCurrent',
            '0000320198',
            {'form': '10-K', 'fy': 2010, 'unit': 'USD'},
        )

    assert values == [5520000000.0]
    assert get.call_count == 3
    assert get.call_args_list[2].args[0].endswith('/CIK0000320198-submissions-001.json')


def test_query_sec_missing_accession_does_not_scan_unrelated_historical_files():
    """Fail closed without downloading shards whose filing range cannot match."""
    concept_response = MagicMock()
    concept_response.status_code = 200
    concept_response.raise_for_status.return_value = None
    concept_response.json.return_value = {
        'units': {
            'USD': [
                {
                    'end': '2025-12-31',
                    'val': 2,
                    'accn': '0000320201-25-000999',
                    'fy': 2025,
                    'form': '10-K',
                }
            ]
        }
    }
    index_response = MagicMock()
    index_response.status_code = 200
    index_response.raise_for_status.return_value = None
    index_response.json.return_value = {
        'filings': {
            'recent': {'accessionNumber': [], 'reportDate': []},
            'files': [
                {
                    'name': 'CIK0000320201-submissions-001.json',
                    'filingFrom': '1994-01-01',
                    'filingTo': '2015-12-31',
                }
            ],
        }
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[concept_response, index_response],
    ) as get:
        values = query_sec('Revenue', '0000320201', {'form': '10-K', 'fy': 2025, 'unit': 'USD'})

    assert values == []
    assert get.call_count == 2


def test_query_sec_reuses_submission_metadata_within_one_task():
    """Repeated answers in one task share the SEC submission index."""

    def response(payload):
        result = MagicMock()
        result.status_code = 200
        result.raise_for_status.return_value = None
        result.json.return_value = payload
        return result

    concept = {
        'units': {
            'USD': [
                {
                    'end': '2025-12-31',
                    'val': 2,
                    'accn': '0000320202-25-000001',
                    'fy': 2025,
                    'form': '10-K',
                }
            ]
        }
    }
    index = {
        'filings': {
            'recent': {
                'accessionNumber': ['0000320202-25-000001'],
                'reportDate': ['2025-12-31'],
            },
            'files': [],
        }
    }
    cache = {}
    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[response(concept), response(index), response(concept)],
    ) as get:
        first = query_sec('Revenue', '0000320202', {'form': '10-K', 'fy': 2025}, cache)
        second = query_sec('Revenue', '0000320202', {'form': '10-K', 'fy': 2025}, cache)

    assert first == second == [2.0]
    assert get.call_count == 3


def test_query_sec_refreshes_submission_index_for_new_filing():
    def response(payload):
        result = MagicMock()
        result.status_code = 200
        result.raise_for_status.return_value = None
        result.json.return_value = payload
        return result

    old_concept = {
        'units': {
            'USD': [
                {
                    'end': '2024-12-31',
                    'val': 1,
                    'accn': 'old-accession',
                    'fy': 2024,
                    'form': '10-K',
                }
            ]
        }
    }
    old_index = {
        'filings': {
            'recent': {
                'accessionNumber': ['old-accession'],
                'reportDate': ['2024-12-31'],
            },
            'files': [],
        }
    }
    new_concept = {
        'units': {
            'USD': [
                {
                    'end': '2025-12-31',
                    'val': 2,
                    'accn': 'new-accession',
                    'fy': 2025,
                    'form': '10-K',
                }
            ]
        }
    }
    new_index = {
        'filings': {
            'recent': {
                'accessionNumber': ['new-accession', 'old-accession'],
                'reportDate': ['2025-12-31', '2024-12-31'],
            },
            'files': [],
        }
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[
            response(old_concept),
            response(old_index),
            response(new_concept),
            response(new_index),
        ],
    ) as get:
        old_values = query_sec('Revenue', '0000320199', {'form': '10-K', 'fy': 2024})
        new_values = query_sec('Revenue', '0000320199', {'form': '10-K', 'fy': 2025})

    assert old_values == [1.0]
    assert new_values == [2.0]
    assert get.call_count == 4


def test_query_sec_refreshes_same_historical_shard_for_rolled_filing():
    def response(payload):
        result = MagicMock()
        result.status_code = 200
        result.raise_for_status.return_value = None
        result.json.return_value = payload
        return result

    shard_name = 'CIK0000320200-submissions-001.json'

    def concept(accession, year, value):
        return {
            'units': {
                'USD': [
                    {
                        'end': f'{year}-12-31',
                        'val': value,
                        'accn': accession,
                        'fy': year,
                        'form': '10-K',
                    }
                ]
            }
        }

    index = {
        'filings': {
            'recent': {'accessionNumber': [], 'reportDate': []},
            'files': [{'name': shard_name}],
        }
    }
    old_shard = {'accessionNumber': ['archived-a'], 'reportDate': ['2024-12-31']}
    updated_shard = {
        'accessionNumber': ['rolled-b', 'archived-a'],
        'reportDate': ['2025-12-31', '2024-12-31'],
    }

    with patch(
        'authoritative_overlay.connectors.sec.requests.get',
        side_effect=[
            response(concept('archived-a', 2024, 1)),
            response(index),
            response(old_shard),
            response(concept('rolled-b', 2025, 2)),
            response(index),
            response(updated_shard),
        ],
    ) as get:
        old_values = query_sec('Revenue', '0000320200', {'form': '10-K', 'fy': 2024})
        new_values = query_sec('Revenue', '0000320200', {'form': '10-K', 'fy': 2025})

    assert old_values == [1.0]
    assert new_values == [2.0]
    assert get.call_count == 6


# --- IInstance.writeAnswers contract -----------------------------------------


class _PreventDefault(Exception):
    pass


def _make_instance(regulator='sec', cik='0000320193'):
    inst = IInstance()
    inst.IGlobal = MagicMock()
    inst.IGlobal.regulator_type = regulator
    inst.IGlobal.cik = cik
    inst.IGlobal.sec_submission_cache = {}
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
    with patch.object(_iinstance_module, 'query_sec', return_value=[69860000000.0]):
        inst.writeAnswers(_answer(payload))
    inst.instance.writeAnswers.assert_not_called()
    inst.preventDefault.assert_not_called()


def test_write_answers_forwards_explicit_start_filter():
    inst = _make_instance()
    payload = {
        'concept': 'RevenueFromContractWithCustomerExcludingAssessedTax',
        'value': '$95,359,000,000',
        'form': '10-Q',
        'fy': 2025,
        'fp': 'Q2',
        'start': '2024-12-29',
        'end': '2025-03-29',
        'unit': 'USD',
    }
    with patch.object(_iinstance_module, 'query_sec', return_value=[95359000000.0]) as query:
        inst.writeAnswers(_answer(payload))

    query.assert_called_once_with(
        payload['concept'],
        cik='0000320193',
        filters={
            'form': '10-Q',
            'fy': 2025,
            'fp': 'Q2',
            'start': '2024-12-29',
            'end': '2025-03-29',
            'unit': 'USD',
        },
        submission_cache=inst.IGlobal.sec_submission_cache,
    )
    inst.preventDefault.assert_not_called()


def test_write_answers_mismatch_abstains():
    inst = _make_instance()
    payload = {
        'concept': 'AccountsPayableCurrent',
        'value': '$999,000',
        'form': '10-K',
        'fy': 2025,
    }
    with patch.object(_iinstance_module, 'query_sec', return_value=[69860000000.0]):
        with pytest.raises(_PreventDefault):
            inst.writeAnswers(_answer(payload))
    inst.instance.writeAnswers.assert_not_called()


def test_write_answers_without_period_abstains():
    inst = _make_instance()
    payload = {'concept': 'AccountsPayableCurrent', 'value': '$69,860,000,000'}
    with patch.object(_iinstance_module, 'query_sec') as query:
        with pytest.raises(_PreventDefault):
            inst.writeAnswers(_answer(payload))
    query.assert_not_called()


def test_write_answers_with_only_unit_abstains_before_querying():
    inst = _make_instance()
    payload = {
        'concept': 'AccountsPayableCurrent',
        'value': '$69,860,000,000',
        'unit': 'USD',
    }
    with patch.object(_iinstance_module, 'query_sec', return_value=[69860000000.0]) as query:
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
    with patch.object(_iinstance_module, 'query_sec') as query:
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
    with patch.object(_iinstance_module, 'query_sec', return_value=[69860000000.0]):
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

    with patch.object(_iglobal_module.Config, 'getNodeConfig', return_value={'regulator_type': 'sec', 'cik': ''}):
        IGlobal.beginGlobal(iglobal)
    assert iglobal.cik == ''


def test_numeric_cik_is_zero_padded():
    iglobal = IGlobal.__new__(IGlobal)
    iglobal.regulator_type = 'sec'
    iglobal.cik = ''
    iglobal.glb = MagicMock()
    iglobal.glb.logicalType = 'authoritative_overlay'
    iglobal.glb.connConfig = {}

    with patch.object(_iglobal_module.Config, 'getNodeConfig', return_value={'regulator_type': 'sec', 'cik': '320193'}):
        IGlobal.beginGlobal(iglobal)
    assert iglobal.cik == '0000320193'
