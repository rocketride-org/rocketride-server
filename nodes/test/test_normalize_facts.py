"""Unit tests for the normalize_facts node.

Pure-logic tests for normalize.py (no engine / rocketlib required): number/sign
parsing, currency and scale detection (tag-only), label->metric mapping,
non-destructive normalization, idempotency, and cross-batch dedupe (conflicts
kept, not dropped). A final section drives ``IInstance`` itself under stubbed
engine modules to pin the lane behaviour: dict-vs-list emission shape, extras
ordering, and the ``_emit`` type branches.
"""

import importlib
import os
import sys
import types

# normalize.py is engine-free (no rocketlib import), so it is imported directly
# with no stubs; the IInstance section below installs (and restores) the full
# stub set it needs.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'nodes', 'normalize_facts'))
from normalize import (  # noqa: E402
    NODE_OP,
    build_mapping,
    detect_currency,
    detect_scale,
    dedupe_facts,
    map_metric,
    normalize_fact,
    normalize_payload,
    parse_number,
)


CFG = {
    'label_field': 'label',
    'value_field': 'value',
    'default_currency': '',
    'decimal_format': 'auto',
    'mapping': build_mapping({'Turnover': 'revenue'}),
}


# --- number & sign parsing --------------------------------------------------


def test_parse_plain_integer():
    value, neg, source = parse_number(42)
    assert int(value) == 42
    assert neg is False
    assert source == 'none'


def test_parse_us_thousands():
    value, _, _ = parse_number('1,234.5')
    assert value == 1234.5


def test_parse_parentheses_negative():
    value, neg, source = parse_number('(100)')
    assert value == -100
    assert neg is True
    assert source == 'parentheses'


def test_parse_trailing_minus():
    value, neg, source = parse_number('100-')
    assert value == -100
    assert source == 'trailing_minus'


def test_parse_leading_minus():
    value, neg, source = parse_number('-100')
    assert value == -100
    assert source == 'leading_minus'


def test_parse_unicode_minus():
    value, neg, _ = parse_number('−100')
    assert value == -100
    assert neg is True


def test_parse_eu_format():
    value, _, _ = parse_number('1.234.567,89', 'eu')
    assert float(value) == 1234567.89


def test_parse_footnote_stripped():
    value, _, _ = parse_number('1,234(a)')
    assert value == 1234


def test_parse_scale_suffix_then_footnote():
    # Regression: the footnote used to block the end-anchored suffix strip,
    # losing the value while detect_scale still tagged millions.
    value, _, _ = parse_number('1,234m(a)')
    assert value == 1234
    value, _, _ = parse_number('1,234m (b)')
    assert value == 1234


def test_parse_negative_with_footnote():
    # Regression: a parenthesised (accounting-negative) figure carrying a
    # footnote used to be dropped (value None while is_negative stayed True),
    # because the footnote was stripped after the sign step. It must keep its
    # value now, across footnote and bracket forms.
    for raw in ('(1,234)(a)', '(1,234) (a)', '(1,234)[1]'):
        value, neg, source = parse_number(raw)
        assert value == -1234, raw
        assert neg is True, raw
        assert source == 'parentheses', raw


def test_parse_trailing_minus_with_footnote():
    value, neg, source = parse_number('1,234-(a)')
    assert value == -1234
    assert neg is True
    assert source == 'trailing_minus'


def test_parse_negative_currency_scale_with_footnote():
    # Currency + scale + accounting-negative + footnote all at once.
    value, neg, source = parse_number('(£456.789m)(a)')
    assert float(value) == -456.789
    assert neg is True
    assert source == 'parentheses'


def test_parse_plain_parenthesised_number_still_negative():
    # A footnote-free (123) must remain an accounting negative, not be eaten by
    # the early footnote strip.
    value, neg, source = parse_number('(123)')
    assert value == -123
    assert neg is True
    assert source == 'parentheses'


def test_parse_currency_symbol_and_scale_suffix():
    value, neg, source = parse_number('(£456.789m)')
    assert float(value) == -456.789
    assert source == 'parentheses'


def test_parse_sentinel_na():
    assert parse_number('N/A') == (None, False, 'none')
    assert parse_number('—') == (None, False, 'none')


def test_parse_boolean_rejected():
    assert parse_number(True) == (None, False, 'none')


def test_parse_unparseable_returns_none():
    value, _, _ = parse_number('not a number')
    assert value is None


# --- currency detection -----------------------------------------------------


def test_detect_currency_value_symbol():
    assert detect_currency('Revenue', '$5') == ('USD', 'value_symbol')


def test_detect_currency_value_code_overrides_dollar():
    assert detect_currency('x', '$5 CAD') == ('CAD', 'value_code')


def test_detect_currency_label_code():
    assert detect_currency('Revenue in GBP', '5') == ('GBP', 'label_code')


def test_detect_currency_none_and_default():
    assert detect_currency('Revenue', '100') == ('', 'none')
    assert detect_currency('Revenue', '100', default_currency='USD') == ('USD', 'config_default')


# --- scale detection --------------------------------------------------------


def test_detect_scale_label_bracket():
    assert detect_scale('Revenue (in millions)', '5') == (1_000_000, 'millions', 'label')


def test_detect_scale_value_suffix():
    assert detect_scale('Assets', '£500m') == (1_000_000, 'millions', 'value')


def test_detect_scale_thousands_k():
    assert detect_scale('x', '100k') == (1_000, 'thousands', 'value')


def test_detect_scale_billions_bn_suffix():
    assert detect_scale('x', '1.2bn') == (1_000_000_000, 'billions', 'value')


def test_detect_scale_none():
    assert detect_scale('Revenue', '100') == (1, '', 'none')


def test_detect_scale_bare_letter_in_prose_ignored():
    assert detect_scale('summary of the memo', '100') == (1, '', 'none')


def test_detect_scale_spaced_suffix_in_prose_ignored():
    # A short suffix must be ADJACENT to the digits: a spaced 'k'/'m'/'b' after
    # a number in ordinary text is not a scale and must not tag the record.
    assert detect_scale('FY 2023 M&A costs', '100') == (1, '', 'none')
    assert detect_scale('Note 12 k', '100') == (1, '', 'none')
    assert detect_scale('Section 3 b', '100') == (1, '', 'none')


# --- label -> metric mapping ------------------------------------------------


def test_map_metric_mapped():
    assert map_metric('Revenue (in millions USD)', CFG['mapping']) == ('revenue', 'mapped')


def test_map_metric_multiword_exact():
    assert map_metric('Diluted Earnings Per Share', CFG['mapping']) == ('diluted_eps', 'mapped')


def test_map_metric_containing_synonym_not_mapped():
    # A label that merely CONTAINS a synonym is a different line item and must
    # fall through to passthrough, not inherit the synonym's metric.
    cases = {
        'Deferred revenue': 'deferred revenue',
        'Non-operating income': 'non-operating income',
        'Revenue growth %': 'revenue growth %',
        'Total assets under management': 'total assets under management',
        'Allowance for doubtful accounts receivable': ('allowance for doubtful accounts receivable'),
    }
    for label, cleaned in cases.items():
        assert map_metric(label, CFG['mapping']) == (cleaned, 'passthrough'), label


def test_map_metric_config_override():
    assert map_metric('Turnover', CFG['mapping']) == ('revenue', 'mapped')


def test_map_metric_passthrough():
    assert map_metric('Weird Line XYZ', CFG['mapping']) == ('weird line xyz', 'passthrough')


def test_map_metric_empty():
    assert map_metric('', CFG['mapping']) == ('', 'empty')


# --- full fact normalization ------------------------------------------------


def test_normalize_fact_full():
    out = normalize_fact({'label': 'Revenue ($ in millions)', 'value': '1,234.5'}, CFG)
    assert out['normalized'] == {
        'metric': 'revenue',
        'value_normalized': 1234.5,
        'currency': 'USD',
        'scale_factor': 1_000_000,
        'scale_unit': 'millions',
        'is_negative': False,
    }
    # Scaled fact: the amount mirror is withheld — currency_convert_explicit
    # multiplies `amount` as-is and never reads scale_factor, so mirroring an
    # as-stated in-millions figure would convert a number off by 10^6.
    assert 'amount' not in out
    assert out['currency'] == 'USD'
    # Raw fields preserved.
    assert out['value'] == '1,234.5'


def test_normalize_fact_amount_mirrored_only_unscaled():
    out = normalize_fact({'label': 'Weird Item', 'value': '$1,234.50'}, CFG)
    assert out['amount'] == 1234.5  # unscaled -> safe to hand to the converter
    scaled = normalize_fact({'label': 'Weird Item', 'value': '1,234m'}, CFG)
    assert 'amount' not in scaled


def test_normalize_fact_negative_gbp_scale():
    out = normalize_fact({'label': 'Cost of Goods Sold', 'value': '(£456.789m)'}, CFG)
    n = out['normalized']
    assert n['metric'] == 'cost_of_goods_sold'
    assert n['value_normalized'] == -456.789
    assert n['currency'] == 'GBP'
    assert n['scale_factor'] == 1_000_000
    assert n['is_negative'] is True
    entry = out['provenance'][-1]
    assert entry['sign_source'] == 'parentheses'
    assert entry['currency_source'] == 'value_symbol'
    assert entry['scale_source'] == 'value'


def test_normalize_fact_unmapped_no_currency():
    out = normalize_fact({'label': 'Weird Line Item XYZ', 'value': 42}, CFG)
    assert out['normalized']['metric'] == 'weird line item xyz'
    assert out['normalized']['value_normalized'] == 42
    assert out['normalized']['currency'] == ''
    assert out['normalized']['scale_factor'] == 1


def test_normalize_fact_non_destructive():
    fact = {'label': 'Revenue', 'value': '100', 'page': 7}
    original = dict(fact)
    out = normalize_fact(fact, CFG)
    assert fact == original  # input not mutated
    assert out['page'] == 7  # extra keys preserved


def test_normalize_fact_scale_not_multiplied():
    out = normalize_fact({'label': 'Revenue (in millions)', 'value': '1,234.5'}, CFG)
    assert out['normalized']['value_normalized'] == 1234.5  # NOT 1_234_500_000
    assert out['normalized']['scale_factor'] == 1_000_000


def test_normalize_fact_scale_suffix_with_footnote():
    # Regression: '1,234m (a)' must keep BOTH the parsed value and the scale
    # tag; the value used to come back null while the scale was still tagged.
    out = normalize_fact({'label': 'Revenue', 'value': '1,234m (a)'}, CFG)
    assert out['normalized']['value_normalized'] == 1234
    assert out['normalized']['scale_factor'] == 1_000_000
    assert out['normalized']['scale_unit'] == 'millions'


def test_normalize_fact_idempotent():
    once = normalize_fact({'label': 'Revenue', 'value': '100'}, CFG)
    twice = normalize_fact(once, CFG)
    assert twice['normalized'] == once['normalized']
    assert twice['normalized']['value_normalized'] == 100


def test_normalize_fact_preserves_existing_provenance():
    out = normalize_fact({'label': 'Revenue', 'value': '100', 'provenance': [{'op': 'extract'}]}, CFG)
    assert len(out['provenance']) == 2
    assert out['provenance'][0] == {'op': 'extract'}
    assert out['provenance'][1]['op'] == NODE_OP


def test_normalize_fact_non_list_provenance_preserved():
    out = normalize_fact({'label': 'Revenue', 'value': '100', 'provenance': 'origin'}, CFG)
    assert out['provenance'][0] == 'origin'
    assert out['provenance'][1]['op'] == NODE_OP


def test_normalize_fact_non_dict_passthrough():
    assert normalize_fact('text', CFG) == 'text'
    assert normalize_fact(42, CFG) == 42


def test_normalize_fact_non_fact_dict_passthrough():
    # A dict with neither label_field nor value_field is not a fact and must
    # pass through untouched — no normalized block, no provenance, same object.
    marker = {'page': 3, 'section': 'Notes to accounts'}
    out = normalize_fact(marker, CFG)
    assert out is marker
    assert 'normalized' not in out
    assert 'provenance' not in out


def test_normalize_fact_top_level_not_clobbered():
    out = normalize_fact({'label': 'Revenue', 'value': '100', 'amount': 999, 'currency': 'JPY'}, CFG)
    assert out['amount'] == 999
    assert out['currency'] == 'JPY'


def test_normalize_payload_list_mixed():
    payload = [{'label': 'Revenue', 'value': '100'}, 'bare-text', 7]
    out = normalize_payload(payload, CFG)
    assert out[0]['normalized']['metric'] == 'revenue'
    assert out[1] == 'bare-text'
    assert out[2] == 7


def test_normalize_payload_scalar_passthrough():
    assert normalize_payload('hello', CFG) == 'hello'
    assert normalize_payload(123, CFG) == 123


# --- dedupe -----------------------------------------------------------------


def _fact(metric, value, currency='USD', scale=1, neg=False):
    return {
        'normalized': {
            'metric': metric,
            'value_normalized': value,
            'currency': currency,
            'scale_factor': scale,
            'is_negative': neg,
        }
    }


def test_dedupe_exact_duplicate_dropped():
    out = dedupe_facts([_fact('revenue', 100), _fact('revenue', 100)])
    assert len(out) == 1


def test_dedupe_conflict_kept():
    out = dedupe_facts([_fact('revenue', 100), _fact('revenue', 200)])
    assert len(out) == 2


def test_dedupe_stable_order():
    facts = [_fact('c', 3), _fact('a', 1), _fact('b', 2), _fact('a', 1)]
    out = dedupe_facts(facts)
    assert [f['normalized']['metric'] for f in out] == ['c', 'a', 'b']


def test_dedupe_null_value_never_merged():
    out = dedupe_facts([_fact('revenue', None), _fact('revenue', None)])
    assert len(out) == 2


def test_dedupe_scale_differs_kept():
    out = dedupe_facts([_fact('revenue', 1, scale=1_000_000), _fact('revenue', 1, scale=1_000)])
    assert len(out) == 2


def test_dedupe_non_normalized_passthrough():
    out = dedupe_facts(['a', 'a', 'b'])
    assert out == ['a', 'b']


def test_dedupe_same_metric_different_label_kept():
    # Regression: two line items mapping to the same metric with the same
    # number are DIFFERENT facts — the raw label is part of the identity key.
    a = dict(_fact('revenue', 100), label='Revenue')
    b = dict(_fact('revenue', 100), label='Deferred revenue')
    out = dedupe_facts([a, b])
    assert len(out) == 2


def test_dedupe_same_label_and_key_dropped():
    a = dict(_fact('revenue', 100), label='Revenue')
    b = dict(_fact('revenue', 100), label='Revenue ($ in millions)')  # cleans to 'revenue'
    c = dict(_fact('revenue', 100), label='revenue')
    out = dedupe_facts([a, b, c])
    assert len(out) == 1


def test_dedupe_end_to_end_distinct_line_items_survive():
    # The reviewer's failure scenario, run through the full pipeline: a filing
    # listing 'Revenue 1,234' and 'Deferred revenue 1,234' must emit two facts.
    facts = [
        normalize_fact({'label': 'Revenue', 'value': '1,234'}, CFG),
        normalize_fact({'label': 'Deferred revenue', 'value': '1,234'}, CFG),
    ]
    out = dedupe_facts(facts)
    assert len(out) == 2
    assert {f['normalized']['metric'] for f in out} == {'revenue', 'deferred revenue'}


# --- IInstance lane behaviour ------------------------------------------------
#
# Import nodes.normalize_facts.IInstance under controlled stubs (pattern from
# test_tool_deepl.py): snapshot every sys.modules name we touch, force-install
# our stubs, evict cached package modules so the import binds the stubs, keep a
# direct module reference, then restore sys.modules exactly.


class _FakeAnswer:
    """Minimal stand-in for ai.common.schema.Answer as IInstance uses it."""

    def __init__(self, expectJson=False):
        self.expectJson = expectJson
        self._data = None

    def setAnswer(self, data):
        self._data = data

    def getJson(self):
        if isinstance(self._data, (dict, list)):
            return self._data
        raise ValueError('answer payload is not JSON')

    def getText(self):
        return self._data if isinstance(self._data, str) else str(self._data)


def _build_instance_stubs():
    rocketlib_stub = types.ModuleType('rocketlib')
    rocketlib_stub.Entry = object
    rocketlib_stub.IInstanceBase = object
    rocketlib_stub.IGlobalBase = object
    rocketlib_stub.warning = lambda *a, **kw: None
    rocketlib_stub.debug = lambda *a, **kw: None
    ai_stub = types.ModuleType('ai')
    ai_common = types.ModuleType('ai.common')
    ai_schema = types.ModuleType('ai.common.schema')
    ai_schema.Answer = _FakeAnswer
    ai_config = types.ModuleType('ai.common.config')
    ai_config.Config = types.SimpleNamespace(getNodeConfig=lambda *a, **kw: {})
    depends_stub = types.ModuleType('depends')
    depends_stub.depends = lambda *a, **kw: None
    return {
        'rocketlib': rocketlib_stub,
        'ai': ai_stub,
        'ai.common': ai_common,
        'ai.common.schema': ai_schema,
        'ai.common.config': ai_config,
        'depends': depends_stub,
    }


_PKG_MODULES = (
    'nodes.normalize_facts.IInstance',
    'nodes.normalize_facts.IGlobal',
    'nodes.normalize_facts.normalize',
    'nodes.normalize_facts',
)
_instance_stubs = _build_instance_stubs()
_touched_names = list(_instance_stubs) + list(_PKG_MODULES)
_MODULE_ABSENT = object()
_saved_modules = {name: sys.modules.get(name, _MODULE_ABSENT) for name in _touched_names}
_src_dir = os.path.join(os.path.dirname(__file__), '..', 'src')
if _src_dir not in sys.path:
    sys.path.insert(0, _src_dir)

try:
    for _name, _stub in _instance_stubs.items():
        sys.modules[_name] = _stub
    for _name in _PKG_MODULES:
        sys.modules.pop(_name, None)
    _II = importlib.import_module('nodes.normalize_facts.IInstance')
finally:
    for _name in _touched_names:
        _prev = _saved_modules[_name]
        if _prev is _MODULE_ABSENT:
            sys.modules.pop(_name, None)
        else:
            sys.modules[_name] = _prev


def _make_instance():
    """Build an IInstance wired to capture stubs; returns (inst, emitted, prevented)."""
    inst = _II.IInstance()
    inst.IGlobal = types.SimpleNamespace(config=dict(CFG))
    emitted = []
    prevented = []
    inst.instance = types.SimpleNamespace(writeAnswers=emitted.append)
    inst.preventDefault = lambda: prevented.append(True)
    inst.open(object())
    return inst, emitted, prevented


def _answer(payload):
    a = _FakeAnswer(expectJson=isinstance(payload, (dict, list)))
    a.setAnswer(payload)
    return a


def test_instance_single_fact_keeps_dict_shape():
    inst, emitted, prevented = _make_instance()
    inst.writeAnswers(_answer({'label': 'Revenue', 'value': '100'}))
    assert prevented  # the default forward must be suppressed
    inst.closing()
    assert len(emitted) == 1
    out = emitted[0]
    assert out.expectJson is True
    payload = out.getJson()
    assert isinstance(payload, dict)  # lone bare dict keeps its shape
    assert payload['normalized']['value_normalized'] == 100


def test_instance_multiple_answers_collapse_to_one_list():
    inst, emitted, _ = _make_instance()
    inst.writeAnswers(_answer({'label': 'Revenue', 'value': '100'}))
    inst.writeAnswers(_answer({'label': 'Inventory', 'value': '7'}))
    inst.closing()
    assert len(emitted) == 1
    payload = emitted[0].getJson()
    assert isinstance(payload, list) and len(payload) == 2


def test_instance_distinct_line_items_not_merged():
    # The review scenario end-to-end through the lane: same number, different
    # line items -> both facts must survive.
    inst, emitted, _ = _make_instance()
    inst.writeAnswers(_answer({'label': 'Revenue', 'value': '1,234'}))
    inst.writeAnswers(_answer({'label': 'Deferred revenue', 'value': '1,234'}))
    inst.closing()
    payload = emitted[0].getJson()
    assert len(payload) == 2


def test_instance_exact_duplicates_merge_to_bare_dict():
    inst, emitted, _ = _make_instance()
    inst.writeAnswers(_answer({'label': 'Revenue', 'value': '100'}))
    inst.writeAnswers(_answer({'label': 'Revenue', 'value': '100'}))
    inst.closing()
    assert len(emitted) == 1
    assert isinstance(emitted[0].getJson(), dict)  # deduped to one -> dict shape


def test_instance_extras_emitted_after_facts_as_text():
    inst, emitted, _ = _make_instance()
    inst.writeAnswers(_answer('a plain note'))
    inst.writeAnswers(_answer({'label': 'Revenue', 'value': '100'}))
    inst.closing()
    assert len(emitted) == 2
    # Facts first (as a list, because extras exist), then the text verbatim.
    assert isinstance(emitted[0].getJson(), list)
    assert emitted[1].expectJson is False
    assert emitted[1].getText() == 'a plain note'


def test_instance_scalar_in_list_emitted_as_text():
    inst, emitted, _ = _make_instance()
    inst.writeAnswers(_answer([{'label': 'Revenue', 'value': '100'}, 42]))
    inst.closing()
    assert len(emitted) == 2
    assert isinstance(emitted[0].getJson(), list)  # saw_list -> list shape kept
    assert emitted[1].expectJson is False
    assert emitted[1].getText() == '42'  # bare scalar rendered as text
