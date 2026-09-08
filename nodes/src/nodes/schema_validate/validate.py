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

"""Pure, engine-free schema validation for the ``schema_validate`` node.

Deliberately free of any RocketRide / rocketlib imports so the validation logic
can be unit-tested in isolation. All checks are deterministic — no I/O,
randomness, or wall-clock — so results are exact and reproducible for audit
trails. The node is a *guard*: it flags inconsistencies (e.g. a cost row stored
as revenue) and records that provenance was checked; it never fixes, drops, or
mutates the facts it inspects.
"""

from __future__ import annotations

from math import isfinite
from typing import Any, Dict, List, Optional, Tuple

#: Identifier written into each fact's ``validation`` block and provenance entry.
NODE_OP = 'schema_validate'

#: Ordering used to roll a fact's flags up to a single severity.
SEVERITY_RANK = {'off': -1, 'ok': 0, 'warning': 1, 'error': 2}

#: Default metric-keyword → canonical-category map that drives the headline
#: "cost row stored as revenue" check. Keys are canonical categories; values are
#: lowercase substrings of a metric label that imply that category. Overridable
#: via the ``category_metric_map`` config field.
DEFAULT_CATEGORY_METRIC_MAP: Dict[str, List[str]] = {
    'revenue': [
        'revenue',
        'revenues',
        'sales',
        'net sales',
        'turnover',
        'income',
        'net income',
        'gross profit',
        'operating income',
        'earnings',
        'proceeds',
        'bookings',
    ],
    'expense': [
        'cost',
        'costs',
        'expense',
        'expenses',
        'cogs',
        'cost of goods',
        'cost of revenue',
        'opex',
        'operating expense',
        'depreciation',
        'amortization',
        'impairment',
        'interest expense',
        'tax',
        'spend',
    ],
    'asset': [
        'asset',
        'assets',
        'cash',
        'receivable',
        'receivables',
        'inventory',
        'goodwill',
    ],
    'liability': [
        'liability',
        'liabilities',
        'payable',
        'payables',
        'debt',
        'loan',
        'borrowing',
    ],
}

#: Declared-category synonyms → canonical map key. Not configurable: it only
#: normalises the *declared* ``category_field`` value before comparison.
CATEGORY_ALIAS: Dict[str, str] = {
    'revenue': 'revenue',
    'revenues': 'revenue',
    'sales': 'revenue',
    'income': 'revenue',
    'turnover': 'revenue',
    'expense': 'expense',
    'expenses': 'expense',
    'cost': 'expense',
    'costs': 'expense',
    'cogs': 'expense',
    'opex': 'expense',
    'asset': 'asset',
    'assets': 'asset',
    'liability': 'liability',
    'liabilities': 'liability',
}

#: Canonical classes whose amounts are expected to be negative (<= 0).
_NEGATIVE_CLASSES = frozenset({'expense', 'liability'})
#: Canonical classes whose amounts are expected to be positive (>= 0).
_POSITIVE_CLASSES = frozenset({'revenue', 'asset'})


def default_config() -> Dict[str, Any]:
    """Built-in configuration; ``IGlobal`` merges engine config over this.

    Every field has a working default so the node validates with zero
    configuration — only the ``category_metric_mismatch`` check is skipped when
    the map is emptied.
    """
    return {
        'amount_field': 'amount',
        'currency_field': 'currency',
        'metric_field': 'metric',
        'category_field': 'category',
        'category_metric_map': {k: list(v) for k, v in DEFAULT_CATEGORY_METRIC_MAP.items()},
        'sign': 'warning',
        'require_provenance': 'error',
    }


def _to_number(value: Any) -> Optional[float]:
    """Best-effort conversion of a JSON scalar to a finite ``float``.

    Returns ``None`` when the value cannot be interpreted as a finite number.
    Booleans are rejected (they are ``int`` in Python but never amounts) and
    comma/currency-formatted strings are rejected — normalising those is the
    upstream ``normalize_facts`` node's job, not this guard's.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return float(value)
    if isinstance(value, float):
        return value if isfinite(value) else None
    if isinstance(value, str):
        try:
            f = float(value.strip())
        except (TypeError, ValueError):
            return None
        return f if isfinite(f) else None
    return None


def _canonical_category(value: Any, alias: Dict[str, str]) -> Optional[str]:
    """Map a declared category value to a canonical key via ``alias``.

    Returns ``None`` when the value is not a string or is not a known synonym.
    """
    if not isinstance(value, str):
        return None
    return alias.get(value.strip().lower())


def _infer_class(
    metric_value: Any, category_metric_map: Dict[str, List[str]], category_alias: Dict[str, str]
) -> Tuple[Optional[str], List[str]]:
    """Infer a fact's canonical class from its metric label.

    Returns ``(inferred, matched_categories)`` where ``inferred`` is:

    - a single canonical category when the label matches keyword(s) resolving to
      exactly one category,
    - ``'ambiguous'`` when it matches keywords resolving to two or more distinct
      categories,
    - ``None`` when it matches none.

    Each map key is resolved through ``category_alias`` — the same table the
    declared category uses — so the two sides of the mismatch comparison share
    one normalisation and cannot drift apart (e.g. a custom map key ``"cost"``,
    a built-in alias for ``expense``, infers ``expense`` just as a declared
    ``"cost"`` resolves to ``expense``). ``matched_categories`` lists the
    distinct resolved categories hit, for messaging.
    """
    if metric_value is None:
        return None, []
    label = str(metric_value).strip().lower()
    if not label:
        return None, []

    matched: List[str] = []
    for category, keywords in category_metric_map.items():
        if not isinstance(keywords, (list, tuple)):
            # Defensive: uphold the pure-function contract even if a caller
            # passes a map whose values are not keyword lists.
            continue
        canon = str(category).strip().lower()
        canon = category_alias.get(canon, canon)
        for kw in keywords:
            if kw and isinstance(kw, str) and kw in label:
                if canon not in matched:
                    matched.append(canon)
                break

    if not matched:
        return None, []
    if len(matched) == 1:
        return matched[0], matched
    return 'ambiguous', matched


def _sign_contradicts(amount: float, cls: Optional[str]) -> bool:
    """True when a numeric amount's sign contradicts its resolved class.

    Expense/liability are expected ``<= 0`` and revenue/asset ``>= 0``. Zero
    never contradicts, and an unresolved class never contradicts.
    """
    if cls in _NEGATIVE_CLASSES:
        return amount > 0
    if cls in _POSITIVE_CLASSES:
        return amount < 0
    return False


def _build_flag(code: str, severity: str, field: str, message: str) -> Dict[str, Any]:
    """Assemble a single flag record."""
    return {'code': code, 'severity': severity, 'field': field, 'message': message}


def validate_fact(fact: Any, config: Dict[str, Any]) -> Any:
    """Validate a single fact record, returning an annotated copy.

    Non-destructive: anything that is not a ``dict`` is returned unchanged. For a
    fact dict, a new dict is returned carrying the original fields plus a
    ``validation`` block (``op``/``valid``/``severity``/``flags``) and an
    appended ``provenance`` entry. The input is never mutated.
    """
    if not isinstance(fact, dict):
        return fact

    amount_field = config.get('amount_field') or 'amount'
    currency_field = config.get('currency_field') or 'currency'
    metric_field = config.get('metric_field') or 'metric'
    category_field = config.get('category_field') or 'category'

    cat_map = config.get('category_metric_map')
    if not isinstance(cat_map, dict):
        cat_map = DEFAULT_CATEGORY_METRIC_MAP
    # These fields accept only off/warning/error (not 'ok'); enforce that here
    # too so the pure function upholds the same contract as IGlobal in isolation.
    sign_sev = config.get('sign', 'warning')
    if sign_sev not in ('off', 'warning', 'error'):
        sign_sev = 'warning'
    prov_sev = config.get('require_provenance', 'error')
    if prov_sev not in ('off', 'warning', 'error'):
        prov_sev = 'error'

    flags: List[Dict[str, Any]] = []

    # --- Amount presence / numeracy (checks 1 & 2, mutually exclusive) --------
    amount_present = amount_field in fact and fact.get(amount_field) is not None
    amount_num: Optional[float] = None
    if not amount_present:
        flags.append(
            _build_flag(
                'missing_amount',
                'warning',
                amount_field,
                f"fact has no '{amount_field}' value",
            )
        )
    else:
        amount_num = _to_number(fact.get(amount_field))
        if amount_num is None:
            flags.append(
                _build_flag(
                    'non_numeric_amount',
                    'warning',
                    amount_field,
                    f"'{amount_field}' value {fact.get(amount_field)!r} is not a finite number",
                )
            )

    # --- Currency presence (check 3) -----------------------------------------
    currency_val = fact.get(currency_field)
    if (
        currency_field not in fact
        or currency_val is None
        or (isinstance(currency_val, str) and not currency_val.strip())
    ):
        flags.append(
            _build_flag(
                'missing_currency',
                'warning',
                currency_field,
                f"fact has no '{currency_field}' value",
            )
        )

    # --- Metric / category coherence (checks 4, 5, 7) ------------------------
    # Recognised declared categories = the built-in aliases plus the (possibly
    # custom) map keys, so a user-defined category such as ``equity`` added to
    # ``category_metric_map`` is not falsely flagged ``unknown_category``. Built
    # once here and shared by both the inferred and declared sides so they use
    # one normalisation and cannot disagree.
    category_alias = dict(CATEGORY_ALIAS)
    for key in cat_map:
        canon = str(key).strip().lower()
        if canon:
            category_alias.setdefault(canon, canon)
    inferred, matched = _infer_class(fact.get(metric_field), cat_map, category_alias)
    declared = _canonical_category(fact.get(category_field), category_alias)
    has_metric = metric_field in fact and fact.get(metric_field) is not None
    has_category = category_field in fact and fact.get(category_field) is not None

    if inferred == 'ambiguous' and has_metric:
        flags.append(
            _build_flag(
                'ambiguous_metric',
                'warning',
                metric_field,
                f'metric {fact.get(metric_field)!r} matches multiple categories {sorted(set(matched))}',
            )
        )
    elif inferred is not None and declared is not None and inferred != declared:
        # The headline "cost row stored as revenue" guard. Both classes are
        # canonical (``inferred`` is a map key, ``declared`` a resolved alias),
        # so any disagreement is a genuine inconsistency — no ``declared in
        # cat_map`` guard, which would silently drop mismatches under a custom
        # map that omits the declared category.
        flags.append(
            _build_flag(
                'category_metric_mismatch',
                'error',
                category_field,
                f"metric {fact.get(metric_field)!r} implies category '{inferred}' but fact declares '{declared}'",
            )
        )

    if has_category and declared is None:
        flags.append(
            _build_flag(
                'unknown_category',
                'warning',
                category_field,
                f'category {fact.get(category_field)!r} is not a recognised classification',
            )
        )

    # --- Sign consistency (check 6, config-gated) ----------------------------
    if sign_sev != 'off' and amount_num is not None:
        # Prefer the declared class when it is a signed class; else the inferred.
        resolved = declared if declared in (_NEGATIVE_CLASSES | _POSITIVE_CLASSES) else None
        if resolved is None and inferred in (_NEGATIVE_CLASSES | _POSITIVE_CLASSES):
            resolved = inferred
        if resolved is not None and _sign_contradicts(amount_num, resolved):
            expected = '<= 0' if resolved in _NEGATIVE_CLASSES else '>= 0'
            flags.append(
                _build_flag(
                    'sign_category_mismatch',
                    sign_sev,
                    amount_field,
                    f"class '{resolved}' expects amount {expected} but amount is {amount_num}",
                )
            )

    # --- Provenance presence (check 8), evaluated on the INCOMING fact --------
    existing_prov = fact.get('provenance')
    if prov_sev != 'off' and (not isinstance(existing_prov, list) or not existing_prov):
        flags.append(
            _build_flag(
                'missing_provenance',
                prov_sev,
                'provenance',
                'fact has no usable provenance list; upstream extraction chain is not recorded',
            )
        )

    # --- Malformed provenance (check 9) --------------------------------------
    if existing_prov is not None and not isinstance(existing_prov, list):
        flags.append(
            _build_flag(
                'malformed_provenance',
                'warning',
                'provenance',
                'provenance is present but not a list; original preserved',
            )
        )

    # --- Roll up severity / valid --------------------------------------------
    severity = 'ok'
    for flag in flags:
        if SEVERITY_RANK.get(flag['severity'], 0) > SEVERITY_RANK.get(severity, 0):
            severity = flag['severity']
    valid = not any(flag['severity'] == 'error' for flag in flags)

    result = dict(fact)
    result['validation'] = {
        'op': NODE_OP,
        'valid': valid,
        'severity': severity,
        'flags': flags,
    }

    entry = {
        'op': NODE_OP,
        'valid': valid,
        'flag_codes': [flag['code'] for flag in flags],
    }
    if isinstance(existing_prov, list):
        # Copy so we never mutate the caller's list; append our entry.
        result['provenance'] = list(existing_prov) + [entry]
    elif existing_prov is None:
        result['provenance'] = [entry]
    else:
        # Preserve an unexpected non-list provenance rather than clobber it.
        result['provenance'] = [existing_prov, entry]

    return result


def validate_payload(payload: Any, config: Dict[str, Any]) -> Any:
    """Apply :func:`validate_fact` to a fact dict or a list of fact dicts.

    Any other payload shape (scalars, strings) — and non-dict elements within a
    list — are returned unchanged. Records are never dropped.
    """
    if isinstance(payload, list):
        return [validate_fact(item, config) for item in payload]
    if isinstance(payload, dict):
        return validate_fact(payload, config)
    return payload
