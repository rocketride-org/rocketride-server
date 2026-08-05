"""Unit tests for the currency_convert_explicit node (convert.py).

Pure-logic tests — no engine / rocketlib required. Cover conversion math,
rounding, non-destructive provenance, custom field names, and pass-through of
every non-matching record shape.
"""

import os
import sys
import types

# convert.py has no rocketlib import, but stub it defensively so importing the
# node package stays isolated; restore after so the stub never leaks.
_saved_rl = sys.modules.get('rocketlib')
rocketlib = types.ModuleType('rocketlib')
rocketlib.debug = lambda *a, **kw: None
sys.modules['rocketlib'] = rocketlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'currency_convert_explicit'))
try:
    from convert import NODE_OP, convert_fact, convert_payload  # noqa: E402
finally:
    if _saved_rl is not None:
        sys.modules['rocketlib'] = _saved_rl
    else:
        sys.modules.pop('rocketlib', None)


CFG = {
    'source_currency': 'EUR',
    'target_currency': 'USD',
    'rate': 1.1,
    'rate_date': '2026-06-30',
    'amount_field': 'amount',
    'currency_field': 'currency',
    'decimals': 2,
}


def test_converts_matching_currency():
    out = convert_fact({'amount': 100, 'currency': 'EUR'}, CFG)
    assert out['converted'] == {'amount': 110.0, 'currency': 'USD'}
    # Original values preserved (non-destructive).
    assert out['amount'] == 100
    assert out['currency'] == 'EUR'


def test_provenance_entry_recorded():
    out = convert_fact({'amount': 100, 'currency': 'EUR'}, CFG)
    assert isinstance(out['provenance'], list)
    assert out['provenance'][-1] == {
        'op': NODE_OP,
        'rate': 1.1,
        'rate_date': '2026-06-30',
        'source_currency': 'EUR',
        'target_currency': 'USD',
    }


def test_rounding_half_up():
    cfg = dict(CFG, rate=1, decimals=2)
    out = convert_fact({'amount': '100.005', 'currency': 'EUR'}, cfg)
    assert out['converted']['amount'] == 100.01


def test_decimals_config():
    cfg = dict(CFG, rate='1.23456', decimals=4)
    out = convert_fact({'amount': 100, 'currency': 'EUR'}, cfg)
    assert out['converted']['amount'] == 123.456


def test_case_insensitive_currency_match():
    out = convert_fact({'amount': 50, 'currency': 'eur'}, CFG)
    assert 'converted' in out


def test_non_matching_currency_passthrough():
    out = convert_fact({'amount': 100, 'currency': 'JPY'}, CFG)
    assert out == {'amount': 100, 'currency': 'JPY'}
    assert 'converted' not in out


def test_missing_fields_passthrough():
    assert convert_fact({'value': 100, 'currency': 'EUR'}, CFG) == {'value': 100, 'currency': 'EUR'}
    assert convert_fact({'amount': 100}, CFG) == {'amount': 100}


def test_non_dict_passthrough():
    assert convert_fact('15000000', CFG) == '15000000'
    assert convert_fact(42, CFG) == 42


def test_non_numeric_amount_passthrough():
    out = convert_fact({'amount': 'N/A', 'currency': 'EUR'}, CFG)
    assert out == {'amount': 'N/A', 'currency': 'EUR'}


def test_boolean_amount_rejected():
    out = convert_fact({'amount': True, 'currency': 'EUR'}, CFG)
    assert 'converted' not in out


def test_invalid_rate_passthrough():
    cfg = dict(CFG, rate='not-a-number')
    out = convert_fact({'amount': 100, 'currency': 'EUR'}, cfg)
    assert 'converted' not in out


def test_missing_target_passthrough():
    cfg = dict(CFG, target_currency='')
    out = convert_fact({'amount': 100, 'currency': 'EUR'}, cfg)
    assert 'converted' not in out


def test_custom_field_names():
    cfg = dict(CFG, amount_field='value', currency_field='ccy')
    out = convert_fact({'value': 200, 'ccy': 'EUR'}, cfg)
    assert out['converted'] == {'amount': 220.0, 'currency': 'USD'}


def test_does_not_mutate_input():
    fact = {'amount': 100, 'currency': 'EUR', 'provenance': [{'op': 'extract'}]}
    out = convert_fact(fact, CFG)
    # Input left untouched.
    assert fact == {'amount': 100, 'currency': 'EUR', 'provenance': [{'op': 'extract'}]}
    # Existing provenance preserved and appended to on the copy.
    assert len(out['provenance']) == 2
    assert out['provenance'][0] == {'op': 'extract'}
    assert out['provenance'][1]['op'] == NODE_OP


def test_non_list_provenance_preserved():
    out = convert_fact({'amount': 100, 'currency': 'EUR', 'provenance': 'origin'}, CFG)
    assert out['provenance'][0] == 'origin'
    assert out['provenance'][1]['op'] == NODE_OP


def test_convert_payload_list():
    payload = [
        {'amount': 100, 'currency': 'EUR'},
        {'amount': 100, 'currency': 'JPY'},
        'bare-text',
    ]
    out = convert_payload(payload, CFG)
    assert out[0]['converted']['currency'] == 'USD'
    assert 'converted' not in out[1]
    assert out[2] == 'bare-text'


def test_convert_payload_scalar_passthrough():
    assert convert_payload('hello', CFG) == 'hello'
    assert convert_payload(123, CFG) == 123
