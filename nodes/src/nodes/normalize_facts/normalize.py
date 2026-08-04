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

"""Pure, engine-free fact normalization for the ``normalize_facts`` node.

Deliberately free of any RocketRide / rocketlib imports so the logic can be
unit-tested in isolation. Parsing and sign handling use :class:`decimal.Decimal`
internally so no precision is lost mid-computation; non-integral results are
emitted as ``float`` for JSON (integral ones as ``int``).

The normalization is deterministic (no LLM, no network): it parses numbers and
signs, *tags* the detected currency and scale (never converts, never multiplies
the value), maps free-text labels to standard metric names, and de-duplicates
identical facts across a batch.
"""

from __future__ import annotations

import json
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Optional, Tuple

#: Identifier written into each normalized fact's provenance entry.
NODE_OP = 'normalize_facts'

# --- currency ---------------------------------------------------------------

#: Symbol -> ISO code. Ordered most-specific first so a bare ``$`` is a last
#: resort. ``$`` maps to USD deterministically (no CAD/AUD guessing).
_CURRENCY_SYMBOLS: Tuple[Tuple[str, str], ...] = (
    ('€', 'EUR'),
    ('£', 'GBP'),
    ('₹', 'INR'),
    ('₽', 'RUB'),
    ('¥', 'JPY'),
    ('$', 'USD'),
)

#: ISO 4217 codes we recognise as explicit currency tags in text.
_ISO_CODES = (
    'USD',
    'EUR',
    'GBP',
    'JPY',
    'CHF',
    'CAD',
    'AUD',
    'CNY',
    'INR',
    'MXN',
    'BRL',
    'RUB',
    'HKD',
    'SGD',
    'KRW',
    'SEK',
    'NOK',
    'DKK',
    'NZD',
    'ZAR',
)
_ISO_CODE_RE = re.compile(r'\b(' + '|'.join(_ISO_CODES) + r')\b')
#: Case-insensitive variant used only to strip codes out of a numeric string.
_ISO_CODE_STRIP_RE = re.compile(r'\b(?:' + '|'.join(_ISO_CODES) + r')\b', re.IGNORECASE)

# --- scale ------------------------------------------------------------------

#: Word forms and unambiguous abbreviations, longest magnitude first so that
#: ``million`` is not shadowed by ``thousand`` etc.
_SCALE_WORDS: Tuple[Tuple[int, str, str], ...] = (
    (1_000_000_000, 'billions', r'billions?|bn'),
    (1_000_000, 'millions', r'millions?|mn|mm'),
    (1_000, 'thousands', r'thousands?'),
)
#: A number immediately followed by a bare/short scale suffix: ``500m``, ``1.2bn``.
#: The suffix must be adjacent to the digits — a spaced suffix is far more
#: likely ordinary text (``Note 12 k``, ``FY 2023 M&A``) than a scale, and a
#: wrong tag would sit in the audit record and the dedupe identity key.
_SCALE_SUFFIX_RE = re.compile(r'(?<![a-z])\d[\d.,]*(bn|mn|mm|[kmb])\b', re.IGNORECASE)
_SUFFIX_MAP = {
    'k': (1_000, 'thousands'),
    'm': (1_000_000, 'millions'),
    'mn': (1_000_000, 'millions'),
    'mm': (1_000_000, 'millions'),
    'b': (1_000_000_000, 'billions'),
    'bn': (1_000_000_000, 'billions'),
}

# --- number parsing ---------------------------------------------------------

#: Sentinel strings that represent "no value" rather than a number.
_NIL_TOKENS = frozenset({'', '-', '—', '–', 'n/a', 'na', 'nil', 'none'})
#: Unicode dash / minus variants normalised to ASCII '-'.
_DASHES = ('−', '‐', '‑', '–', '—', '―')
#: A trailing scale suffix on the numeric token, stripped before parsing.
_NUM_SUFFIX_RE = re.compile(r'(billions?|millions?|thousands?|bn|mn|mm|[kmb])\s*$', re.IGNORECASE)
#: A trailing footnote marker such as ``(a)`` or ``[1]``.
_FOOTNOTE_RE = re.compile(r'\s*(\([a-z0-9]{1,3}\)|\[[0-9]{1,3}\])\s*$', re.IGNORECASE)
#: An *unambiguous* trailing footnote, safe to strip before sign handling: a
#: ``[n]`` bracket, or a parenthesised token that contains a letter (``(a)``,
#: ``(iv)``). Deliberately does NOT match a plain parenthesised number like
#: ``(123)`` — that is an accounting-negative, handled by the sign step.
_FOOTNOTE_EARLY_RE = re.compile(
    r'\s*(?:\[[0-9]{1,3}\]|\((?=[a-z0-9]{1,3}\))[a-z0-9]*[a-z][a-z0-9]*\))\s*$',
    re.IGNORECASE,
)


def _to_decimal(value: Any) -> Optional[Decimal]:
    """Best-effort conversion of a JSON scalar to a finite ``Decimal``.

    Returns ``None`` when the value cannot be interpreted as a finite number.
    Booleans are rejected: they are ints in Python but never numeric facts.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        # Route through str() so e.g. 0.1 does not pick up binary-float noise.
        d = Decimal(str(value))
        return d if d.is_finite() else None
    if isinstance(value, str):
        try:
            d = Decimal(value.strip())
        except (InvalidOperation, ValueError):
            return None
        return d if d.is_finite() else None
    return None


def _number(d: Decimal) -> Any:
    """Render a ``Decimal`` as a JSON-serialisable number (int when integral)."""
    if d == d.to_integral_value():
        return int(d)
    return float(d)


def _apply_separators(s: str, decimal_format: str) -> str:
    """Strip grouping separators and normalise the decimal point.

    ``eu`` treats ``.`` as the thousands separator and ``,`` as the decimal
    point; ``us``/``auto`` treat ``,`` (and spaces) as thousands separators and
    ``.`` as the decimal point. Auto never sniffs locale — it is the US rule.
    """
    s = s.replace(' ', '').replace(' ', '')
    if decimal_format == 'eu':
        s = s.replace('.', '')
        s = s.replace(',', '.')
    else:
        s = s.replace(',', '')
    return s


def parse_number(raw: Any, decimal_format: str = 'auto') -> Tuple[Optional[Decimal], bool, str]:
    """Parse a raw fact value into ``(value, is_negative, sign_source)``.

    Handles JSON numbers directly and cleans strings: parentheses/leading/
    trailing/unicode minus signs, currency symbols and codes, scale suffixes,
    footnote markers and thousands separators. Returns ``(None, ...)`` when the
    value is a nil sentinel or cannot be parsed as a finite number.
    """
    if isinstance(raw, bool):
        return (None, False, 'none')
    if isinstance(raw, (int, float, Decimal)):
        d = _to_decimal(raw)
        if d is None:
            return (None, False, 'none')
        return (d, d < 0, 'none')
    if not isinstance(raw, str):
        return (None, False, 'none')

    s = raw.strip()
    if s.lower() in _NIL_TOKENS:
        return (None, False, 'none')

    for ch in _DASHES:
        s = s.replace(ch, '-')
    s = s.strip()

    # Strip an unambiguous trailing footnote (e.g. ``(a)``, ``(iv)``, ``[1]``)
    # BEFORE sign handling, so a negative figure carrying a footnote keeps its
    # value (``(1,234)(a)`` -> ``(1,234)`` -> -1234). A plain parenthesised
    # number like ``(123)`` is left for the accounting-negative branch below.
    s = _FOOTNOTE_EARLY_RE.sub('', s).strip()

    negative = False
    sign_source = 'none'

    # Parentheses wrap the whole token -> negative (accounting convention).
    if len(s) >= 2 and s[0] == '(' and s[-1] == ')':
        negative = True
        sign_source = 'parentheses'
        s = s[1:-1].strip()

    # Strip currency markers so only the number remains (detection is separate).
    for sym, _code in _CURRENCY_SYMBOLS:
        s = s.replace(sym, '')
    s = s.replace('¢', '')
    s = _ISO_CODE_STRIP_RE.sub(' ', s).strip()

    if s.startswith('-'):
        if not negative:
            negative, sign_source = True, 'leading_minus'
        s = s[1:].strip()
    if s.endswith('-'):
        if not negative:
            negative, sign_source = True, 'trailing_minus'
        s = s[:-1].strip()
    if s.startswith('+'):
        s = s[1:].strip()
        if sign_source == 'none':
            sign_source = 'explicit_plus'

    # Strip a trailing footnote marker first (1,234m(a)): both regexes are
    # end-anchored, so a footnote after a scale suffix would block the suffix.
    s = _FOOTNOTE_RE.sub('', s).strip()
    # Strip a trailing scale suffix (500m, 1.2bn) — scale is tagged separately.
    s = _NUM_SUFFIX_RE.sub('', s).strip()

    s = _apply_separators(s, decimal_format)
    d = _to_decimal(s)
    if d is None:
        return (None, negative, sign_source)
    if negative:
        d = -abs(d)
    return (d, d < 0, sign_source)


def _find_symbol(text: str) -> str:
    for sym, code in _CURRENCY_SYMBOLS:
        if sym in text:
            return code
    return ''


def _find_iso(text: str) -> str:
    m = _ISO_CODE_RE.search(text.upper())
    return m.group(1) if m else ''


def detect_currency(label: Any, value: Any, default_currency: str = '') -> Tuple[str, str]:
    """Detect the currency and its source, tagging only — never converting.

    Value evidence beats label evidence, and an explicit ISO code beats a bare
    symbol (so ``$5 CAD`` is CAD, not USD). Returns ``(code, source)`` where
    ``source`` is one of ``value_code``/``value_symbol``/``label_code``/
    ``label_symbol``/``config_default``/``none``.
    """
    val = value if isinstance(value, str) else ''
    lab = label if isinstance(label, str) else ''

    code = _find_iso(val)
    if code:
        return (code, 'value_code')
    sym = _find_symbol(val)
    if sym:
        return (sym, 'value_symbol')
    code = _find_iso(lab)
    if code:
        return (code, 'label_code')
    sym = _find_symbol(lab)
    if sym:
        return (sym, 'label_symbol')
    if default_currency:
        return (default_currency, 'config_default')
    return ('', 'none')


def detect_scale(label: Any, value: Any) -> Tuple[int, str, str]:
    """Detect the reporting scale and its source, tagging only — never applied.

    Labels are searched before values (headers usually carry the scale). Returns
    ``(factor, unit, source)`` with ``factor == 1`` / ``unit == ''`` when no
    scale is present. The returned factor is recorded for audit; the value is
    never multiplied (that would risk the scale-header double-apply bug).
    """
    for text, source in ((label, 'label'), (value, 'value')):
        if not isinstance(text, str) or not text.strip():
            continue
        t = text.lower()
        for factor, unit, pattern in _SCALE_WORDS:
            if re.search(r'\b(?:' + pattern + r')\b', t):
                return (factor, unit, source)
        m = _SCALE_SUFFIX_RE.search(t)
        if m:
            factor, unit = _SUFFIX_MAP[m.group(1).lower()]
            return (factor, unit, source)
    return (1, '', 'none')


# --- label -> metric mapping ------------------------------------------------

#: Starter set of standard financial metrics and their common synonyms. Stored
#: metric -> [synonyms]; inverted to synonym -> metric by :func:`build_mapping`.
DEFAULT_METRIC_SYNONYMS: Dict[str, List[str]] = {
    'revenue': ['revenue', 'revenues', 'sales', 'total revenue', 'net sales', 'turnover'],
    'cost_of_goods_sold': ['cost of goods sold', 'cogs', 'cost of sales', 'cost of revenue'],
    'gross_profit': ['gross profit', 'gross income'],
    'operating_expenses': ['operating expenses', 'opex', 'operating costs'],
    'operating_income': ['operating income', 'operating profit', 'ebit'],
    'income_before_tax': ['income before tax', 'pre-tax income', 'earnings before tax', 'ebt'],
    'net_income': ['net income', 'net profit', 'net earnings', 'profit for the year'],
    'ebitda': ['ebitda'],
    'total_assets': ['total assets'],
    'current_assets': ['current assets'],
    'total_liabilities': ['total liabilities'],
    'current_liabilities': ['current liabilities'],
    'shareholders_equity': ['shareholders equity', 'stockholders equity', 'total equity'],
    'cash_and_equivalents': ['cash and cash equivalents', 'cash and equivalents'],
    'accounts_receivable': ['accounts receivable', 'trade receivables'],
    'accounts_payable': ['accounts payable', 'trade payables'],
    'inventory': ['inventory', 'inventories'],
    'long_term_debt': ['long-term debt', 'long term debt'],
    'earnings_per_share': ['earnings per share', 'eps', 'basic eps'],
    'diluted_eps': ['diluted eps', 'diluted earnings per share'],
}

#: Bracketed qualifiers that only carry currency/scale info and are dropped
#: before metric matching (semantic qualifiers such as "(diluted)" are kept).
_QUALIFIER_RE = re.compile(
    r'\((?:in\s+)?(?:thousands|millions|billions|\$|€|£|¥|₹|usd|eur|gbp|jpy|inr)[^)]*\)',
    re.IGNORECASE,
)


def build_mapping(overrides: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Build the ``synonym -> metric`` lookup, merging user overrides on top.

    Keys are lower-cased so matching is case-insensitive. User overrides win on
    conflict and may introduce new metrics. A non-dict ``overrides`` is ignored.
    """
    mapping: Dict[str, str] = {}
    for metric, synonyms in DEFAULT_METRIC_SYNONYMS.items():
        for syn in synonyms:
            mapping[syn.lower()] = metric
    if isinstance(overrides, dict):
        for syn, metric in overrides.items():
            if isinstance(syn, str) and isinstance(metric, str):
                mapping[syn.strip().lower()] = metric
    return mapping


def clean_label(label: Any) -> str:
    """Lower-case, strip qualifiers/symbols and collapse whitespace in a label."""
    if not isinstance(label, str):
        return ''
    s = label.strip().lower()
    s = _QUALIFIER_RE.sub(' ', s)
    for sym, _code in _CURRENCY_SYMBOLS:
        s = s.replace(sym, '')
    s = s.replace('¢', '')
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def map_metric(label: Any, mapping: Dict[str, str]) -> Tuple[str, str]:
    """Map a free-text label to a standard metric name.

    Returns ``(metric, source)``. ``source`` is ``mapped`` on a hit, ``empty``
    for a blank label, or ``passthrough`` (the cleaned label, never dropped)
    when nothing matches. Matching is exact on the cleaned label only: a label
    that merely *contains* a synonym (``Deferred revenue``, ``Non-operating
    income``) is a different line item and must not inherit its metric, so it
    falls through to ``passthrough``.
    """
    cleaned = clean_label(label)
    if not cleaned:
        return ('', 'empty')
    if cleaned in mapping:
        return (mapping[cleaned], 'mapped')
    return (cleaned, 'passthrough')


# --- fact normalization -----------------------------------------------------


def normalize_fact(fact: Any, cfg: Dict[str, Any]) -> Any:
    """Normalize a single fact record; anything that is not a dict is returned as-is.

    Non-destructive: the raw fields are preserved, a ``normalized`` block and a
    ``provenance`` entry are added. Scale and currency are tagged, never applied
    or converted. Idempotent for the ``normalized`` block: re-running overwrites
    it and never mutates the raw value, so the number cannot drift. Each pass
    intentionally appends its own ``provenance`` entry, so the trail records
    every normalization that touched the fact.
    """
    if not isinstance(fact, dict):
        return fact

    label_field = cfg.get('label_field') or 'label'
    value_field = cfg.get('value_field') or 'value'

    # A dict carrying neither the label nor the value field is not a fact
    # (page markers, section headers, ...) — pass it through untouched.
    if label_field not in fact and value_field not in fact:
        return fact

    decimal_format = cfg.get('decimal_format') or 'auto'
    mapping = cfg.get('mapping') or {}
    default_currency = cfg.get('default_currency') or ''

    label = fact.get(label_field)
    raw_value = fact.get(value_field)

    value, is_negative, sign_source = parse_number(raw_value, decimal_format)
    currency, currency_source = detect_currency(label, raw_value, default_currency)
    scale_factor, scale_unit, scale_source = detect_scale(label, raw_value)
    metric, metric_source = map_metric(label, mapping)

    value_num = _number(value) if value is not None else None

    normalized = {
        'metric': metric,
        'value_normalized': value_num,
        'currency': currency,
        'scale_factor': scale_factor,
        'scale_unit': scale_unit,
        'is_negative': is_negative,
    }
    entry = {
        'op': NODE_OP,
        'value_normalized': value_num,
        'currency': currency,
        'currency_source': currency_source,
        'scale_factor': scale_factor,
        'scale_unit': scale_unit,
        'scale_source': scale_source,
        'sign_source': sign_source,
        'metric_source': metric_source,
    }

    result = dict(fact)
    result['normalized'] = normalized

    existing = result.get('provenance')
    if isinstance(existing, list):
        result['provenance'] = list(existing) + [entry]
    elif existing is None:
        result['provenance'] = [entry]
    else:
        # Preserve an unexpected non-list provenance rather than clobber it.
        result['provenance'] = [existing, entry]

    # Mirror amount/currency to the top level so the downstream
    # currency_convert_explicit node works with its default field names — but
    # only when those keys are absent, never overwriting upstream values, and
    # only when the fact is unscaled: the converter multiplies ``amount``
    # as-is and never reads ``scale_factor``, so mirroring an as-stated
    # "1,234.5 (in millions)" would convert a number off by the scale factor.
    if value_num is not None and 'amount' not in result and scale_factor == 1:
        result['amount'] = value_num
    if currency and 'currency' not in result:
        result['currency'] = currency

    return result


def normalize_payload(payload: Any, cfg: Dict[str, Any]) -> Any:
    """Apply :func:`normalize_fact` to a fact dict or a list of facts.

    Any other payload shape (scalars, strings) is returned unchanged.
    """
    if isinstance(payload, list):
        return [normalize_fact(item, cfg) for item in payload]
    if isinstance(payload, dict):
        return normalize_fact(payload, cfg)
    return payload


def dedupe_facts(facts: List[Any], label_field: str = 'label') -> List[Any]:
    """Drop exact-duplicate normalized facts, preserving first-seen order.

    Two facts are duplicates only when their identity key — cleaned raw label,
    metric, normalized value, currency, scale factor and sign — is identical.
    The raw label is part of the key because different line items can map to
    the same metric (or collide in passthrough): ``Revenue`` and ``Deferred
    revenue`` carrying the same number are distinct facts, and a genuine fact
    must never be dropped. Facts that share a label and metric but differ in
    value/currency/scale are conflicts, not duplicates, and are all kept.
    Facts with an unparseable (``None``) value are never merged.
    """
    seen = set()
    out: List[Any] = []
    for index, fact in enumerate(facts):
        if isinstance(fact, dict) and isinstance(fact.get('normalized'), dict):
            n = fact['normalized']
            value = n.get('value_normalized')
            if value is None:
                key: Any = ('__null__', index)
            else:
                key = (
                    clean_label(fact.get(label_field)),
                    n.get('metric'),
                    value,
                    n.get('currency'),
                    n.get('scale_factor'),
                    n.get('is_negative'),
                )
        else:
            try:
                key = ('__raw__', json.dumps(fact, sort_keys=True))
            except (TypeError, ValueError):
                key = ('__rawid__', index)
        if key in seen:
            continue
        seen.add(key)
        out.append(fact)
    return out
