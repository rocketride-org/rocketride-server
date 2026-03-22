"""
Tests for IBM Watson location parameter validation.

Verifies that the location allowlist and regex check prevent SSRF
and credential exfiltration via crafted location values.
"""

import re
import pytest

# ---------------------------------------------------------------------------
# Replicate the validation logic from ibm_watson.py so we can unit-test it
# in isolation without needing the IBM SDK or RocketRide internals.
# ---------------------------------------------------------------------------

_VALID_LOCATIONS = frozenset({
    'us-south', 'us-east', 'eu-gb', 'eu-de', 'eu-es',
    'jp-tok', 'jp-osa', 'au-syd', 'ca-tor', 'br-sao',
})

_LOCATION_RE = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')


def _validate_location(location):
    """Mirror the validation logic from Chat.__init__."""
    if not location or 'Select Location' in location:
        raise ValueError('Please select a location.')
    if not _LOCATION_RE.match(location):
        raise ValueError(f'Invalid location format: {location!r}')
    if location not in _VALID_LOCATIONS:
        raise ValueError(
            f'Unknown IBM Cloud location: {location!r}. '
            f'Valid locations: {", ".join(sorted(_VALID_LOCATIONS))}'
        )
    return f'https://{location}.ml.cloud.ibm.com'


# ---- Tests for valid locations -------------------------------------------

class TestValidLocations:
    """All known IBM Cloud regions must be accepted."""

    @pytest.mark.parametrize('loc', sorted(_VALID_LOCATIONS))
    def test_valid_location_accepted(self, loc):
        url = _validate_location(loc)
        assert url == f'https://{loc}.ml.cloud.ibm.com'


# ---- Tests for SSRF / injection payloads ---------------------------------

class TestSSRFInjection:
    """Malicious location values must be rejected."""

    @pytest.mark.parametrize('payload', [
        'attacker.com/x#',               # fragment injection
        'attacker.com/x?',               # query injection
        'evil.com:443/path#',            # port + fragment
        'evil.com@legitimate.com',       # userinfo injection
        '../../../etc/passwd',           # path traversal
        'us-south.ml.cloud.ibm.com#',   # full domain with fragment
        'attacker.com\\@ibm.com',        # backslash injection
    ])
    def test_ssrf_payload_rejected(self, payload):
        with pytest.raises(ValueError):
            _validate_location(payload)


# ---- Tests for unknown but well-formed locations -------------------------

class TestUnknownLocation:
    """Locations that pass regex but are not in the allowlist must fail."""

    @pytest.mark.parametrize('loc', [
        'us-west',
        'eu-fr',
        'ap-southeast',
        'test-region',
    ])
    def test_unknown_region_rejected(self, loc):
        with pytest.raises(ValueError, match='Unknown IBM Cloud location'):
            _validate_location(loc)


# ---- Tests for empty / placeholder values --------------------------------

class TestEmptyAndPlaceholder:
    """Empty strings and the UI placeholder must be rejected."""

    def test_empty_string(self):
        with pytest.raises(ValueError):
            _validate_location('')

    def test_none_value(self):
        with pytest.raises(ValueError):
            _validate_location(None)

    def test_select_location_placeholder(self):
        with pytest.raises(ValueError, match='Please select a location'):
            _validate_location('Select Location')

    def test_select_location_with_prefix(self):
        with pytest.raises(ValueError):
            _validate_location('Please Select Location here')


# ---- Tests for regex enforcement -----------------------------------------

class TestRegexEnforcement:
    """Values with disallowed characters must be rejected by the regex."""

    @pytest.mark.parametrize('bad', [
        'US-SOUTH',           # uppercase
        'us south',           # space
        'us_south',           # underscore
        'us.south',           # dot
        '-us-south',          # leading hyphen
        'us-south-',          # trailing hyphen
        'us--south',          # double hyphen (passes regex but not allowlist)
    ])
    def test_invalid_format_rejected(self, bad):
        with pytest.raises(ValueError):
            _validate_location(bad)
