# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Crustdata tool node instance.

Exposes ``company_search`` and ``person_search`` as @tool_function methods,
giving an agent structured B2B discovery data (firmographics, funding,
headcount, verified people profiles) via Crustdata's filter-based search API.

VERIFIED SURFACE (see #2129): the endpoints, filter/condition schema, and
cursor pagination here are read directly from Crustdata's own versioned API
reference (docs.crustdata.com/company-docs/search/reference,
docs.crustdata.com/person-docs/search/reference, x-api-version 2025-11-01) --
not paraphrased from marketing pages. What remains unverified is everything
that reference doesn't enumerate: the full searchable-field list per entity,
and whether a given API key's plan includes the "live"/real-time variants
Crustdata also advertises. No live account has exercised this end-to-end.
"""

from __future__ import annotations

from typing import Any, Dict, List

import requests

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, post_with_retry

from .IGlobal import IGlobal, _coerce_limit

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

CRUSTDATA_BASE_URL = 'https://api.crustdata.com'
COMPANY_SEARCH_URL = f'{CRUSTDATA_BASE_URL}/company/search'
PERSON_SEARCH_URL = f'{CRUSTDATA_BASE_URL}/person/search'

# Every endpoint requires this version pin (docs.crustdata.com); /screener/*
# and /data_lab/* are documented as legacy predecessors of this versioned API.
CRUSTDATA_API_VERSION = '2025-11-01'

# Per Crustdata's reference, limit is 1-1000 (default 20 server-side; this
# node's own default comes from node config, see IGlobal.default_limit).
_MAX_LIMIT = 1000

# The record-list key each endpoint's response uses, per the reference pages.
_COMPANY_RECORDS_KEY = 'companies'
_PERSON_RECORDS_KEY = 'profiles'

_CONDITION_SCHEMA = {
    'type': 'object',
    'required': ['field', 'type', 'value'],
    'properties': {
        'field': {
            'type': 'string',
            'description': (
                "The dotted field path to filter on, e.g. 'basic_info.primary_domain' (company), "
                "'experience.employment_details.current.title' (person), 'locations.country'. "
                "See Crustdata's field reference for the full searchable list per entity."
            ),
        },
        'type': {
            'type': 'string',
            'enum': [
                '=',
                '!=',
                '<',
                '=<',
                '>',
                '=>',
                'in',
                'not_in',
                'is_null',
                'is_not_null',
                '(.)',
                '[.]',
                'geo_distance',
                'geo_exclude',
            ],
            'description': (
                "The filter operator. '(.)' is fuzzy/contains match, '[.]' is exact list membership, "
                "'geo_distance'/'geo_exclude' take a {location, distance, unit} object as value. "
                "Use '=<'/'=>' rather than '<='/'>='."
            ),
        },
        'value': {
            'description': 'The value to match: a scalar, array, or (for geo_distance) an object.',
        },
    },
}

_FILTERS_SCHEMA = {
    'type': 'array',
    'minItems': 1,
    'items': _CONDITION_SCHEMA,
    'description': (
        'One or more filter conditions. Multiple conditions are combined per "match" (default: all must hold).'
    ),
}

_SORTS_SCHEMA = {
    'type': 'array',
    'items': {
        'type': 'object',
        'required': ['field', 'order'],
        'properties': {
            'field': {'type': 'string'},
            'order': {'type': 'string', 'enum': ['asc', 'desc']},
        },
    },
    'description': (
        'Optional sort order. Strongly recommended whenever paginating with "cursor": '
        'changing sort order between pages invalidates the cursor.'
    ),
}

_OUTPUT_SCHEMA = {
    'type': 'object',
    'properties': {
        'success': {'type': 'boolean'},
        'filters': {'type': 'array'},
        'count': {'type': 'integer'},
        'results': {'type': 'array', 'items': {'type': 'object'}},
        'total_count': {'type': ['integer', 'null']},
        'next_cursor': {'type': ['string', 'null']},
        'error': {'type': 'string'},
    },
}


def _input_schema() -> Dict[str, Any]:
    return {
        'type': 'object',
        'required': ['filters'],
        'properties': {
            'filters': _FILTERS_SCHEMA,
            'match': {
                'type': 'string',
                'enum': ['and', 'or'],
                'description': "How multiple filter conditions combine. Defaults to 'and'.",
            },
            'sorts': _SORTS_SCHEMA,
            'limit': {
                'type': 'integer',
                'description': f'Maximum number of results to return (1-{_MAX_LIMIT}). Defaults to the node config value.',
            },
            'cursor': {
                'type': 'string',
                'description': (
                    "Pagination cursor from a previous call's next_cursor. Omit for the first page. "
                    'Keep filters/sorts identical across pages or the cursor is invalidated.'
                ),
            },
        },
    }


class IInstance(IInstanceBase):
    """Node instance exposing Crustdata company/people search as agent tools."""

    IGlobal: IGlobal

    @tool_function(
        input_schema=_input_schema(),
        output_schema=_OUTPUT_SCHEMA,
        description=(
            'Search Crustdata for companies matching one or more filters (industry, region, headcount, '
            'funding, current company, and more). Returns structured company records: firmographics, '
            'funding history, headcount, and hiring signals. Use this to find prospects or research '
            'accounts by criteria, not to look up one already-known company by name.'
        ),
    )
    def company_search(self, args):
        """Search Crustdata's company index by filter criteria."""
        return self._search(args, url=COMPANY_SEARCH_URL, records_key=_COMPANY_RECORDS_KEY, tool_name='company_search')

    @tool_function(
        input_schema=_input_schema(),
        output_schema=_OUTPUT_SCHEMA,
        description=(
            'Search Crustdata for people matching one or more filters (current company, current title, '
            'region, and more). Returns structured profiles: name, title, work history, education, and '
            'verified contact info where available. Use this to find or enrich people by criteria.'
        ),
    )
    def person_search(self, args):
        """Search Crustdata's people index by filter criteria."""
        return self._search(args, url=PERSON_SEARCH_URL, records_key=_PERSON_RECORDS_KEY, tool_name='person_search')

    # -------------------------------------------------------------------
    # Shared request path
    # -------------------------------------------------------------------

    def _search(self, args: Dict[str, Any], *, url: str, records_key: str, tool_name: str) -> Dict[str, Any]:
        args = normalize_tool_input(args, tool_name=tool_name)

        conditions = args.get('filters')
        if not isinstance(conditions, list) or not conditions:
            return {
                'success': False,
                'filters': [],
                'count': 0,
                'results': [],
                'error': f'{tool_name}: "filters" is required and must be a non-empty array',
            }

        cfg = self.IGlobal
        raw_limit = args.get('limit')
        limit = cfg.default_limit if raw_limit is None else _coerce_limit(raw_limit, default=cfg.default_limit)

        match = args.get('match')
        # 'and'/'or' only: company search's op enum has no third value, and person
        # search's 'all_of' is not a generic combinator -- it's constrained to a
        # single nested-array field path (employment, education, ...), rejects
        # scalar fields, and can't hold negation or nest another all_of. None of
        # that fits a flat "combine any conditions" match parameter.
        if match not in ('and', 'or'):
            match = 'and'

        # Crustdata's schema: a single bare condition, or {op, conditions: [...]} for
        # more than one. Always sending the group form is simpler and equally valid.
        payload: Dict[str, Any] = {
            'filters': {'op': match, 'conditions': conditions},
            'limit': limit,
        }

        sorts = args.get('sorts')
        if isinstance(sorts, list) and sorts:
            payload['sorts'] = sorts

        cursor = args.get('cursor')
        if isinstance(cursor, str) and cursor:
            payload['cursor'] = cursor

        headers = _crustdata_headers(cfg.apikey)

        try:
            resp = post_with_retry(url, headers=headers, json=payload)
            response = resp.json()
        except requests.exceptions.InvalidJSONError:
            # resp.json() raises JSONDecodeError, a subclass of both InvalidJSONError
            # and RequestException — catch it before the generic handler.
            return {
                'success': False,
                'filters': conditions,
                'count': 0,
                'results': [],
                'error': 'Crustdata returned a non-JSON response body',
            }
        except requests.RequestException as exc:
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            detail = f' (HTTP {status})' if status else ''
            return {
                'success': False,
                'filters': conditions,
                'count': 0,
                'results': [],
                'error': f'Crustdata search request failed{detail}: {type(exc).__name__}',
            }

        records = _extract_records(response, records_key)
        out: Dict[str, Any] = {
            'success': True,
            'filters': conditions,
            'count': len(records),
            'results': records,
        }
        if isinstance(response, dict):
            if 'next_cursor' in response:
                out['next_cursor'] = response.get('next_cursor')
            if 'total_count' in response:
                out['total_count'] = response.get('total_count')
        return out


# ---------------------------------------------------------------------------
# Helpers (pure, no network — unit-testable without mocking requests)
# ---------------------------------------------------------------------------


def _crustdata_headers(apikey: str) -> Dict[str, str]:
    return {
        'accept': 'application/json',
        'content-type': 'application/json',
        'authorization': f'Bearer {apikey}',
        'x-api-version': CRUSTDATA_API_VERSION,
    }


def _extract_records(body: Any, records_key: str) -> List[Dict[str, Any]]:
    """Extract the record list from a search response body.

    ``records_key`` is the verified top-level key for the endpoint that was
    called ('companies' or 'profiles', per Crustdata's reference pages) and is
    tried first; a small set of other plausible keys is tried after it as a
    resilience fallback, since only the documented shape — not every edge
    case (e.g. an error body, or a future field rename) — has been confirmed.
    Non-dict items are dropped rather than raised on.
    """
    if isinstance(body, list):
        return [item for item in body if isinstance(item, dict)]
    if not isinstance(body, dict):
        return []
    for key in (records_key, 'results', 'data'):
        value = body.get(key)
        if isinstance(value, list):
            return [item for item in value if isinstance(item, dict)]
    return []
