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

import requests
from rocketlib import debug, warning

# SEC fair-access policy asks for a contact so they can reach operators before throttling.
_SEC_USER_AGENT = 'RocketRide Authoritative Overlay support@rocketride.org'

_PERIOD_KEYS = ('form', 'fy', 'fp', 'end', 'frame')


def _coerce_filter_value(key: str, value):
    """Normalize a filter for comparison with an SEC measurement field."""
    if key == 'fy':
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    return str(value).strip().lower()


def _measurement_matches(measurement: dict, unit: str, filters: dict) -> bool:
    """Return True when a company-concept measurement satisfies every provided filter."""
    if 'unit' in filters and str(unit) != str(filters['unit']):
        return False
    for key in _PERIOD_KEYS:
        if key not in filters:
            continue
        expected = _coerce_filter_value(key, filters[key])
        actual_raw = measurement.get(key)
        if expected is None or actual_raw is None:
            return False
        actual = _coerce_filter_value(key, actual_raw)
        if actual != expected:
            return False
    return True


def select_official_values(units: dict, filters: dict | None) -> list[float]:
    """Pick numeric values from a company-concept `units` map, scoped by period filters.

    Matching is fail-closed: if no period/unit filter is provided, return an empty
    list rather than treating "this number appeared in any historical filing" as a
    verification. Callers must supply at least one of form, fy, fp, end, frame, or unit.
    """
    active = {k: v for k, v in (filters or {}).items() if v not in (None, '')}
    if not active:
        return []

    values: list[float] = []
    for unit, measurements in (units or {}).items():
        if not isinstance(measurements, list):
            continue
        for measurement in measurements:
            if not isinstance(measurement, dict):
                continue
            if not _measurement_matches(measurement, unit, active):
                continue
            val = measurement.get('val')
            if val is None:
                continue
            try:
                values.append(float(val))
            except (TypeError, ValueError):
                continue
    return values


def query_sec(concept: str, cik: str, filters: dict | None = None):
    """Query the US SEC EDGAR company-concept API for a us-gaap concept.

    Returns the list of values that match `filters`, or None if the query fails.
    An empty list means the query succeeded but nothing matched the period scope.
    """
    if not cik:
        warning('SEC EDGAR requires a CIK.')
        return None

    url = f'https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json'
    headers = {'User-Agent': _SEC_USER_AGENT}

    try:
        response = requests.get(url, headers=headers, timeout=10)

        if response.status_code == 404:
            debug(f'US SEC concept {concept} not found for CIK {cik}')
            return None

        response.raise_for_status()
        data = response.json()
        return select_official_values(data.get('units', {}), filters)
    except requests.exceptions.RequestException as e:
        warning(f'US SEC API query failed: {str(e)}')
        return None
