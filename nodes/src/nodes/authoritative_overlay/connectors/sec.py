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
_SUBMISSIONS_URL = 'https://data.sec.gov/submissions'

_PERIOD_KEYS = ('form', 'fy', 'fp', 'start', 'end', 'frame')


def _has_period_scope(filters: dict) -> bool:
    """Return whether filters identify at least part of a filing period."""
    return any(key in filters for key in _PERIOD_KEYS)


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


def _matching_measurements(units: dict, filters: dict):
    """Yield SEC measurements satisfying the caller's explicit filters."""
    for unit, measurements in (units or {}).items():
        if not isinstance(measurements, list):
            continue
        for measurement in measurements:
            if isinstance(measurement, dict) and _measurement_matches(measurement, unit, filters):
                yield measurement


def _report_dates(payload: dict) -> dict[str, str]:
    """Extract accession -> report date pairs from a submissions response."""
    rows = payload.get('filings', {}).get('recent', payload) if isinstance(payload, dict) else {}
    if not isinstance(rows, dict):
        return {}
    accessions = rows.get('accessionNumber', [])
    dates = rows.get('reportDate', [])
    if not isinstance(accessions, list) or not isinstance(dates, list):
        return {}
    return {
        str(accession): str(report_date)
        for accession, report_date in zip(accessions, dates)
        if accession not in (None, '') and report_date not in (None, '')
    }


def _load_submission_index(cik: str) -> tuple[dict[str, str], tuple[str, ...]]:
    """Load the mutable recent-filing index and historical shard names."""
    response = requests.get(
        f'{_SUBMISSIONS_URL}/CIK{cik}.json',
        headers={'User-Agent': _SEC_USER_AGENT},
        timeout=10,
    )
    response.raise_for_status()
    payload = response.json()
    files = payload.get('filings', {}).get('files', []) if isinstance(payload, dict) else []
    names = tuple(
        str(item['name'])
        for item in files
        if isinstance(item, dict) and isinstance(item.get('name'), str) and item['name'].endswith('.json')
    )
    return _report_dates(payload), names


def _load_submission_file(name: str) -> dict[str, str]:
    """Load current report dates from one SEC historical-submissions shard.

    The SEC can update a same-named shard as filings roll out of the recent
    index, so this response must not be cached for the process lifetime.
    """
    response = requests.get(
        f'{_SUBMISSIONS_URL}/{name}',
        headers={'User-Agent': _SEC_USER_AGENT},
        timeout=10,
    )
    response.raise_for_status()
    return _report_dates(response.json())


def _resolve_report_dates(cik: str, accessions: set[str]) -> dict[str, str]:
    """Resolve only the filing accessions needed to scope the selected facts."""
    recent, files = _load_submission_index(cik)
    resolved = {accession: recent[accession] for accession in accessions if accession in recent}
    missing = accessions - resolved.keys()
    for name in files:
        if not missing:
            break
        older = _load_submission_file(name)
        for accession in tuple(missing):
            if accession in older:
                resolved[accession] = older[accession]
                missing.remove(accession)
    return resolved


def select_official_values(
    units: dict,
    filters: dict | None,
    report_dates: dict[str, str] | None = None,
) -> list[float]:
    """Pick numeric values from a company-concept `units` map, scoped by period filters.

    Matching is fail-closed: callers must provide a filing-period selector, and
    implicit periods require accession-to-report-date metadata. ``unit`` may
    narrow a scoped lookup but does not establish a period by itself.
    """
    active = {k: v for k, v in (filters or {}).items() if v not in (None, '')}
    if not _has_period_scope(active):
        return []

    needs_report_date = 'end' not in active and 'frame' not in active
    if needs_report_date and report_dates is None:
        return []

    matches = list(_matching_measurements(units, active))

    # SEC fy/fp describe the filing, not each fact's own reporting period. A
    # 10-K therefore gives its comparative prior-year facts the current filing's
    # fy/fp too. Unless the caller explicitly chose an end/frame, keep only the
    # facts ending on the filing's authoritative reportDate.
    if needs_report_date:
        if any(item.get('accn') in (None, '') for item in matches):
            return []
        accessions = {str(item['accn']) for item in matches}
        if not accessions or any(accession not in report_dates for accession in accessions):
            return []
        filing_dates = {report_dates[accession] for accession in accessions}
        if len(filing_dates) != 1:
            return []
        report_date = next(iter(filing_dates))
        matches = [item for item in matches if str(item.get('end', '')) == report_date]

    # One filing can contain both quarter-only and year-to-date facts ending on
    # the same report date. Never let either value verify an underspecified
    # claim: an explicit start/frame can disambiguate, otherwise abstain.
    periods = {(item.get('start'), item.get('end')) for item in matches}
    if len(periods) > 1:
        return []

    values: list[float] = []
    for measurement in matches:
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

    active = {k: v for k, v in (filters or {}).items() if v not in (None, '')}
    if not _has_period_scope(active):
        return []

    url = f'https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json'
    headers = {'User-Agent': _SEC_USER_AGENT}

    try:
        response = requests.get(url, headers=headers, timeout=10)

        if response.status_code == 404:
            debug(f'US SEC concept {concept} not found for CIK {cik}')
            return None

        response.raise_for_status()
        data = response.json()
        units = data.get('units', {})

        if 'end' in active or 'frame' in active:
            return select_official_values(units, active)

        matches = list(_matching_measurements(units, active))
        if not matches or any(item.get('accn') in (None, '') for item in matches):
            return []
        accessions = {str(item['accn']) for item in matches}
        report_dates = _resolve_report_dates(cik, accessions)
        return select_official_values(units, active, report_dates)
    except requests.exceptions.RequestException as e:
        warning(f'US SEC API query failed: {str(e)}')
        return None
