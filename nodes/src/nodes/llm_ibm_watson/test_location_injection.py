"""
Tests for IBM Watson location parameter validation.

Verifies that the location allowlist and regex check prevent SSRF
and credential exfiltration via crafted location values.
"""

import importlib
import importlib.util
import os
import sys
import types

import pytest

# ---------------------------------------------------------------------------
# Import _validate_location from the actual ibm_watson module without
# triggering its heavy runtime dependencies (IBM SDK, RocketRide internals).
# We load the file as a standalone module and stub out unavailable imports.
# ---------------------------------------------------------------------------

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD_PATH = os.path.join(_HERE, 'ibm_watson.py')


def _load_validate_location():
    """Load _validate_location from ibm_watson.py, stubbing runtime deps."""
    # Create lightweight stubs for packages that are unavailable in tests
    stub_names = [
        'ai', 'ai.common', 'ai.common.chat', 'ai.common.config',
        'ibm_watsonx_ai', 'ibm_watsonx_ai.foundation_models',
        'ibm_watsonx_ai.foundation_models.schema',
    ]
    saved = {}
    for name in stub_names:
        saved[name] = sys.modules.get(name)
        stub = types.ModuleType(name)
        # Provide dummy classes that the module-level references need
        if name == 'ai.common.chat':
            stub.ChatBase = type('ChatBase', (), {})
        if name == 'ai.common.config':
            stub.Config = type('Config', (), {})
        if name == 'ibm_watsonx_ai':
            stub.Credentials = type('Credentials', (), {})
        if name == 'ibm_watsonx_ai.foundation_models':
            stub.ModelInference = type('ModelInference', (), {})
        if name == 'ibm_watsonx_ai.foundation_models.schema':
            stub.TextChatParameters = type('TextChatParameters', (), {})
        sys.modules[name] = stub

    try:
        spec = importlib.util.spec_from_file_location('_ibm_watson', _MOD_PATH)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod._validate_location
    finally:
        # Restore original sys.modules state
        for name in stub_names:
            if saved[name] is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved[name]


_validate_location = _load_validate_location()


# ---- Tests for valid locations -------------------------------------------

class TestValidLocations:
    """All known IBM Cloud regions must be accepted."""

    @pytest.mark.parametrize('loc', [
        'au-syd', 'br-sao', 'ca-tor', 'eu-de', 'eu-es',
        'eu-gb', 'jp-osa', 'jp-tok', 'us-east', 'us-south',
    ])
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
        with pytest.raises(ValueError, match='Invalid location format'):
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
        with pytest.raises(ValueError, match='Please select a location'):
            _validate_location('')

    def test_none_value(self):
        with pytest.raises(ValueError, match='Please select a location'):
            _validate_location(None)

    def test_select_location_placeholder(self):
        with pytest.raises(ValueError, match='Please select a location'):
            _validate_location('Select Location')

    def test_select_location_with_prefix(self):
        with pytest.raises(ValueError, match='Please select a location'):
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
        with pytest.raises(ValueError, match='Invalid location format|Unknown IBM Cloud'):
            _validate_location(bad)
