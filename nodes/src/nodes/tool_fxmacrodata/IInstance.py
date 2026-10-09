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
FXMacroData tool node instance.

Exposes the FXMacroData REST API (https://api.fxmacrodata.com/v1) as read-only
agent tools: latest released values per currency, indicator release history,
the release calendar, the indicator catalogue, and FX reference rates.

Every tool returns ``{success: true, ...}`` or ``{success: false, error}``; an
agent sees a failure as data rather than as a raised exception. Keyless-tier
notices from the API (90-day window, 15-minute delay) are returned in
``notices`` so an agent does not present delayed data as current.
"""

from __future__ import annotations

from typing import Any, Callable, Dict

from rocketlib import IInstanceBase, tool_function

from ai.common.utils import normalize_tool_input, optional_int

from .fxmacrodata_client import (
    DEFAULT_LIMIT,
    MAX_LIMIT,
    SUBSCRIBE_URL,
    FXMacroDataClient,
    FXMacroDataError,
    collect_notices,
    project,
    require_rows,
    scrub_value,
    validate_currency,
    validate_date_range,
    validate_slug,
)
from .IGlobal import IGlobal

# Hard cap on pages followed in one call, so one tool call stays bounded.
MAX_PAGES = 5
DEFAULT_CALENDAR_LIMIT = 50

_LATEST_FIELDS = (
    'indicator',
    'name',
    'unit',
    'frequency',
    'latest',
    'previous',
    'pct_diff_prev',
    'pct_change_yoy',
    'pct_change_qoq',
    'pct_change_mom',
    'has_official_forecast',
)
_HISTORY_FIELDS = (
    'date',
    'val',
    'announcement_datetime',
    'announcement_datetime_local',
    'previous_value',
    'previous_date',
    'change_from_previous',
    'pct_change_from_previous',
    'val_mom',
    'release_time_assumed',
    'source_url',
)
_CALENDAR_FIELDS = (
    'release',
    'name',
    'announcement_datetime',
    'announcement_datetime_utc',
    'announcement_datetime_local',
    'release_date_confirmed',
    'event_importance',
)
_CATALOGUE_FIELDS = ('name', 'unit', 'frequency', 'has_official_forecast')
_FX_FIELDS = ('date', 'val', 'open', 'high', 'low', 'close')

# ---------------------------------------------------------------------------
# Shared schema fragments
# ---------------------------------------------------------------------------

_CURRENCY_PROP = {
    'type': 'string',
    'description': (
        'Three-letter currency code, e.g. USD, EUR, GBP, JPY, AUD. Without an API key only USD data is '
        'available (the data catalogue works for every currency).'
    ),
}
_DATE_PROPS = {
    'start_date': {'type': 'string', 'description': 'Optional start date, YYYY-MM-DD.'},
    'end_date': {'type': 'string', 'description': 'Optional end date, YYYY-MM-DD. Must not be before start_date.'},
}
_PAGE_PROPS = {
    'limit': {
        'type': 'integer',
        'description': f'Rows per page (1-{MAX_LIMIT}, default {DEFAULT_LIMIT}).',
    },
    'offset': {
        'type': 'integer',
        'description': "Row offset of the first page (default 0). Pass a previous call's next_offset to continue.",
    },
    'max_pages': {
        'type': 'integer',
        'description': f'Pages to read in this call, following next_offset (1-{MAX_PAGES}, default 1).',
    },
}
_ERROR_PROPS = {
    'success': {'type': 'boolean'},
    'error': {'type': 'string'},
    'notices': {
        'type': 'array',
        'items': {'type': 'string'},
        'description': 'Keyless-tier notices (90-day window, 15-minute delay). Relay them to the user.',
    },
}


def _output_schema(**properties: Any) -> Dict[str, Any]:
    return {'type': 'object', 'properties': {**_ERROR_PROPS, **properties}}


def _input_schema(required: list, **properties: Any) -> Dict[str, Any]:
    return {'type': 'object', 'required': required, 'properties': properties}


# ---------------------------------------------------------------------------
# Tool handlers (pure apart from the client; unit-testable with a mocked transport)
# ---------------------------------------------------------------------------


def _page_args(args: Dict[str, Any], tool_name: str) -> Dict[str, int]:
    return {
        'limit': optional_int(args, 'limit', default=DEFAULT_LIMIT, lo=1, hi=MAX_LIMIT, tool_name=tool_name),
        'offset': optional_int(args, 'offset', default=0, lo=0, tool_name=tool_name),
        'max_pages': optional_int(args, 'max_pages', default=1, lo=1, hi=MAX_PAGES, tool_name=tool_name),
    }


def _paged_result(fetched: Dict[str, Any], fields: tuple) -> Dict[str, Any]:
    pagination = fetched['pagination'] or {}
    rows = [project(row, fields) for row in fetched['rows']]
    return {
        'count': len(rows),
        'data': rows,
        'has_more': bool(pagination.get('has_more')),
        'next_offset': pagination.get('next_offset'),
        'total_count': pagination.get('total_count'),
        'notices': fetched['notices'],
    }


def fetch_latest_announcements(client: FXMacroDataClient, args: Dict[str, Any]) -> Dict[str, Any]:
    """Latest released value of every indicator for one currency."""
    currency = validate_currency(args.get('currency'))
    body = client.get_json(f'/announcements/{currency}/latest')
    rows = [project(row, _LATEST_FIELDS) for row in require_rows(body)]
    return {
        'currency': currency.upper(),
        'as_of': body.get('as_of'),
        'count': len(rows),
        'data': rows,
        'notices': collect_notices(body),
    }


def fetch_indicator_history(client: FXMacroDataClient, args: Dict[str, Any]) -> Dict[str, Any]:
    """Release history for one currency/indicator pair."""
    currency = validate_currency(args.get('currency'))
    indicator = validate_slug(args.get('indicator'))
    params = validate_date_range(args)
    paging = _page_args(args, 'indicator_history')
    fetched = client.get_pages(f'/announcements/{currency}/{indicator}', params, **paging)
    first = fetched['first'] or {}
    return {
        'currency': currency.upper(),
        'indicator': indicator,
        'name': first.get('name'),
        **_paged_result(fetched, _HISTORY_FIELDS),
    }


def _calendar_event(row: Dict[str, Any]) -> Dict[str, Any]:
    event = project(row, _CALENDAR_FIELDS)
    # The API's `date` is the period the release refers to, not when it is published.
    if row.get('date') is not None:
        event['reference_period'] = row['date']
    return event


def fetch_release_calendar(client: FXMacroDataClient, args: Dict[str, Any]) -> Dict[str, Any]:
    """Scheduled releases for one currency, optionally for one indicator."""
    currency = validate_currency(args.get('currency'))
    params: Dict[str, Any] = validate_date_range(args)
    if args.get('indicator') is not None:
        params['indicator'] = validate_slug(args.get('indicator'))
    limit = optional_int(
        args, 'limit', default=DEFAULT_CALENDAR_LIMIT, lo=1, hi=MAX_LIMIT, tool_name='release_calendar'
    )
    body = client.get_json(f'/calendar/{currency}', params)
    events = [_calendar_event(row) for row in require_rows(body)]
    return {
        'currency': currency.upper(),
        'timezone': body.get('timezone'),
        'count': min(len(events), limit),
        'total_events': len(events),
        'truncated': len(events) > limit,
        'data': events[:limit],
        'notices': collect_notices(body),
    }


def fetch_data_catalogue(client: FXMacroDataClient, args: Dict[str, Any]) -> Dict[str, Any]:
    """Indicator slugs served for one currency."""
    currency = validate_currency(args.get('currency'))
    body = client.get_json(f'/data_catalogue/{currency}')
    indicators = [
        {'indicator': slug, **project(entry, _CATALOGUE_FIELDS)}
        for slug, entry in body.items()
        if isinstance(entry, dict)
    ]
    if not indicators:
        raise FXMacroDataError('unexpected FXMacroData response: the catalogue lists no indicators')
    return {'currency': currency.upper(), 'count': len(indicators), 'indicators': indicators}


def fetch_fx_rates(client: FXMacroDataClient, args: Dict[str, Any]) -> Dict[str, Any]:
    """Daily FX reference rates for a currency pair (API key required)."""
    base = validate_currency(args.get('base'), 'base')
    quote = validate_currency(args.get('quote'), 'quote')
    if base == quote:
        raise FXMacroDataError('"base" and "quote" must be different currencies')
    params = validate_date_range(args)
    paging = _page_args(args, 'fx_rates')
    if not client.has_key:
        raise FXMacroDataError(
            f'fx_rates needs an FXMacroData API key; FX rates are not on the keyless tier. Get a key at {SUBSCRIBE_URL}'
        )
    fetched = client.get_pages(f'/forex/{base}/{quote}', params, **paging)
    return {'pair': f'{base.upper()}/{quote.upper()}', **_paged_result(fetched, _FX_FIELDS)}


class IInstance(IInstanceBase):
    """Node instance exposing FXMacroData as agent tools."""

    IGlobal: IGlobal

    def _run(
        self, tool_name: str, handler: Callable[[FXMacroDataClient, Dict[str, Any]], Dict[str, Any]], args: Any
    ) -> Dict[str, Any]:
        api_key = self.IGlobal.api_key
        try:
            normalized = normalize_tool_input(args, tool_name=tool_name)
            result = handler(FXMacroDataClient(api_key), normalized)
        except ValueError as exc:
            return {'success': False, 'error': api_key.scrub(str(exc))}
        return scrub_value({'success': True, **result}, api_key)

    @tool_function(
        input_schema=_input_schema(['currency'], currency=_CURRENCY_PROP),
        output_schema=_output_schema(
            currency={'type': 'string'},
            as_of={'type': ['string', 'null']},
            count={'type': 'integer'},
            data={'type': 'array', 'items': {'type': 'object'}},
        ),
        description=(
            'Latest released value of every macroeconomic indicator FXMacroData serves for one currency '
            '(policy rate, CPI, GDP, unemployment, payrolls, bond yields and more), with the previous value '
            'and percentage changes. Release time is announcement_datetime (Unix seconds, UTC).'
        ),
    )
    def latest_announcements(self, args):
        """Return the latest release of every indicator for a currency."""
        return self._run('latest_announcements', fetch_latest_announcements, args)

    @tool_function(
        input_schema=_input_schema(
            ['currency', 'indicator'],
            currency=_CURRENCY_PROP,
            indicator={
                'type': 'string',
                'description': 'Indicator slug such as inflation, policy_rate or non_farm_payrolls (see data_catalogue).',
            },
            **_DATE_PROPS,
            **_PAGE_PROPS,
        ),
        output_schema=_output_schema(
            currency={'type': 'string'},
            indicator={'type': 'string'},
            name={'type': ['string', 'null']},
            count={'type': 'integer'},
            data={'type': 'array', 'items': {'type': 'object'}},
            has_more={'type': 'boolean'},
            next_offset={'type': ['integer', 'null']},
            total_count={'type': ['integer', 'null']},
        ),
        description=(
            'Release history of one indicator for one currency, newest first: each row has the reference '
            'period (date), value (val), release time (announcement_datetime) and the change from the previous '
            'release. Paginated: when has_more is true, call again with offset=next_offset.'
        ),
    )
    def indicator_history(self, args):
        """Return the release history of one indicator."""
        return self._run('indicator_history', fetch_indicator_history, args)

    @tool_function(
        input_schema=_input_schema(
            ['currency'],
            currency=_CURRENCY_PROP,
            indicator={'type': 'string', 'description': 'Optional indicator slug to keep only that release.'},
            start_date={'type': 'string', 'description': 'Optional first release date, YYYY-MM-DD.'},
            end_date={'type': 'string', 'description': 'Optional last release date, YYYY-MM-DD.'},
            limit={
                'type': 'integer',
                'description': f'Maximum events returned (1-{MAX_LIMIT}, default {DEFAULT_CALENDAR_LIMIT}).',
            },
        ),
        output_schema=_output_schema(
            currency={'type': 'string'},
            timezone={'type': ['string', 'null']},
            count={'type': 'integer'},
            total_events={'type': 'integer'},
            truncated={'type': 'boolean'},
            data={'type': 'array', 'items': {'type': 'object'}},
        ),
        description=(
            'Scheduled macroeconomic releases for one currency. The release time is announcement_datetime '
            '(Unix seconds, UTC; announcement_datetime_utc / _local as ISO text). reference_period is the '
            'period the release covers, NOT the release date.'
        ),
    )
    def release_calendar(self, args):
        """Return scheduled releases for a currency."""
        return self._run('release_calendar', fetch_release_calendar, args)

    @tool_function(
        input_schema=_input_schema(['currency'], currency=_CURRENCY_PROP),
        output_schema=_output_schema(
            currency={'type': 'string'},
            count={'type': 'integer'},
            indicators={'type': 'array', 'items': {'type': 'object'}},
        ),
        description=(
            'List the indicator slugs FXMacroData serves for a currency, with name, unit and frequency. '
            'Use it to find the slug to pass to indicator_history or release_calendar. Works without an API key '
            'for every currency.'
        ),
    )
    def data_catalogue(self, args):
        """Return the indicator catalogue for a currency."""
        return self._run('data_catalogue', fetch_data_catalogue, args)

    @tool_function(
        input_schema=_input_schema(
            ['base', 'quote'],
            base={'type': 'string', 'description': 'Base currency code, e.g. EUR.'},
            quote={'type': 'string', 'description': 'Quote currency code, e.g. USD.'},
            **_DATE_PROPS,
            **_PAGE_PROPS,
        ),
        output_schema=_output_schema(
            pair={'type': 'string'},
            count={'type': 'integer'},
            data={'type': 'array', 'items': {'type': 'object'}},
            has_more={'type': 'boolean'},
            next_offset={'type': ['integer', 'null']},
            total_count={'type': ['integer', 'null']},
        ),
        description=(
            'Daily official FX reference rates for a currency pair (date, val, and open/high/low/close where '
            'available). Requires an FXMacroData API key. Paginated like indicator_history.'
        ),
    )
    def fx_rates(self, args):
        """Return daily FX reference rates for a pair."""
        return self._run('fx_rates', fetch_fx_rates, args)
