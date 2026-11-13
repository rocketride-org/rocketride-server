"""Precision of the ``pii_leak`` rule, and whether its warning can be acted on.

Two failure modes reinforce each other: rules that fire on things that are not
PII make triage necessary, and a warning that reports only a count makes triage
impossible. These tests pin both directions -- the false positives must stop,
and the real detections must keep working.

The module bootstrap below is duplicated from ``test_all.py`` rather than
imported from it, so this file stands alone and does not couple to a sibling
test module's private helpers.
"""

import importlib.util
import os
import sys
import types

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE_PATH = os.path.join(_HERE, '..', '..', 'src', 'nodes', 'guardrails', 'guardrails_engine.py')


def _load_engine_module():
    """Load guardrails_engine.py as a standalone module."""
    # Stub rocketlib only while loading; restore so it never leaks to sibling tests.
    _saved_rl = sys.modules.get('rocketlib')
    _rocketlib_stub = types.ModuleType('rocketlib')
    _rocketlib_stub.warning = lambda msg, *a, **kw: None
    sys.modules['rocketlib'] = _rocketlib_stub
    spec = importlib.util.spec_from_file_location('guardrails_engine_pii', _ENGINE_PATH)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
        return mod
    finally:
        if _saved_rl is not None:
            sys.modules['rocketlib'] = _saved_rl
        else:
            sys.modules.pop('rocketlib', None)


_engine = _load_engine_module()
Engine = _engine.GuardrailsEngine


def hits(kind, text):
    """Matches of one PII pattern, through the same filter the rule uses."""
    return Engine._pii_matches(kind, Engine.PII_PATTERNS[kind], text)


# ---------------------------------------------------------------------------
# phone_us must not fire on bare ten-digit ids
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'label, text',
    [
        ('slack message ts', '1785525294.884619'),
        ('epoch seconds', 'order 1737049182 shipped'),
        ('bare ten digits', 'reference 4155550142 attached'),
        ('database key', 'row id 9876543210'),
        ('two ids in a sentence', 'linking 1785525294 to 1737049182'),
    ],
)
def test_a_bare_run_of_ten_digits_is_not_a_phone_number(label, text):
    """Unix timestamps, order ids and database keys are ten digits routinely.

    The old pattern made every separator and the country code optional, so it
    reduced to "ten digits". One run over Slack content reported 124 phone
    numbers, every one of them a message id.
    """
    assert hits('phone_us', text) == [], label


# ---------------------------------------------------------------------------
# ...but real phone numbers must still be caught
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'label, text',
    [
        ('parenthesised', 'call (415) 555-0142 today'),
        ('dashed', 'call 415-555-0142 today'),
        ('dotted', 'call 415.555.0142 today'),
        ('spaced', 'call 415 555 0142 today'),
        ('international', 'call +1 415 555 0142 today'),
        ('international dashed', 'call +1-415-555-0142 today'),
    ],
)
def test_a_formatted_phone_number_is_still_detected(label, text):
    """Formatting is what separates a phone number from an id."""
    assert hits('phone_us', text), label


def test_a_parenthesised_number_is_captured_whole():
    """The old pattern's unbalanced parens matched '415) 555-0142'."""
    assert hits('phone_us', 'call (415) 555-0142') == ['(415) 555-0142']


# ---------------------------------------------------------------------------
# ip_address must not fire on addresses that identify nobody
# ---------------------------------------------------------------------------


def test_a_loopback_address_is_not_personal_information():
    """A service URL in an output is not a privacy incident."""
    assert hits('ip_address', 'GET http://127.0.0.1:8791/health') == []


def test_the_unspecified_address_is_not_personal_information():
    """0.0.0.0 is a bind wildcard, not a host, so it identifies nobody."""
    assert hits('ip_address', 'listening on 0.0.0.0:8080') == []


@pytest.mark.parametrize('text', ['from 203.0.113.44', 'host 192.168.1.8', 'gateway 10.0.0.1'])
def test_a_routable_or_private_address_is_still_detected(text):
    """Those can genuinely leak topology, so they keep firing."""
    assert hits('ip_address', text)


# ---------------------------------------------------------------------------
# the other three patterns must be unaffected by the filter
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'kind, text',
    [
        ('email', 'write to alex@example.com please'),
        ('ssn', 'ssn 123-45-6789 on file'),
        ('credit_card', 'card 4111 1111 1111 1111 expires soon'),
    ],
)
def test_the_remaining_patterns_pass_through_unchanged(kind, text):
    """_pii_matches only filters ip_address; everything else is a passthrough."""
    assert hits(kind, text)


# ---------------------------------------------------------------------------
# the warning has to be actionable
# ---------------------------------------------------------------------------


def test_a_pii_warning_names_enough_to_diagnose_it():
    """A bare count cannot be triaged.

    Every other rule in guardrails_engine already names what it matched --
    prompt injection quotes the match, blocked topics quote the topic,
    hallucination quotes the sentence. pii_leak reported only a number, so the
    only way to judge a finding was to re-derive the input and re-run the regex
    by hand.
    """
    engine = Engine({})
    result = engine.check_pii_leak('card 4111 1111 1111 1111 on file')

    assert result['passed'] is False
    assert 'credit_card' in result['details']
    # a sample is present, and it is not the raw value
    assert '[' in result['details'] and ']' in result['details']
    assert '4111 1111 1111 1111' not in result['details']


def test_the_mask_never_reproduces_the_value():
    """Enough to recognise a false positive, never enough to be the leak."""
    masked = Engine._mask('4111111111111111')
    assert masked.startswith('41')
    assert masked.endswith('11')
    assert '*' in masked
    assert masked != '4111111111111111'
    assert len(masked) == len('4111111111111111')


def test_short_values_are_masked_completely():
    """Two of four characters is most of the value, so show none of it."""
    assert Engine._mask('abcd') == '****'
    assert Engine._mask('123456') == '******'


def test_a_timestamp_stays_recognisable_through_the_mask():
    """The mask has to make a false positive identifiable, or it defeats itself."""
    masked = Engine._mask('1785525294')
    assert masked.startswith('17')
    assert masked.endswith('94')


def test_clean_text_still_passes():
    """Text with no PII must report passed, with no sample to include."""
    engine = Engine({})
    result = engine.check_pii_leak('the quarterly report is attached')
    assert result['passed'] is True
