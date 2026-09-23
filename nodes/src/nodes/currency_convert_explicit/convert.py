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

"""Pure, engine-free currency conversion for the ``currency_convert_explicit`` node.

Deliberately free of any RocketRide / rocketlib imports so the conversion logic
can be unit-tested in isolation. All arithmetic uses :class:`decimal.Decimal`
with ``ROUND_HALF_UP`` so results are exact and reproducible for audit trails.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP, InvalidOperation
from typing import Any, Dict, Optional

#: Identifier written into each converted fact's provenance entry.
NODE_OP = 'currency_convert_explicit'


def _to_decimal(value: Any) -> Optional[Decimal]:
    """Best-effort conversion of a JSON scalar to a finite ``Decimal``.

    Returns ``None`` when the value cannot be interpreted as a finite number.
    Booleans are rejected: they are ints in Python but never monetary amounts.
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


def _quantize(amount: Decimal, decimals: int) -> Decimal:
    """Round ``amount`` to ``decimals`` fractional digits, half-up."""
    if decimals < 0:
        decimals = 0
    exponent = Decimal(1).scaleb(-decimals)  # 10 ** -decimals
    return amount.quantize(exponent, rounding=ROUND_HALF_UP)


def _number(d: Decimal) -> float:
    """Render a ``Decimal`` as a JSON-serialisable number."""
    return float(d)


def convert_fact(fact: Any, cfg: Dict[str, Any]) -> Any:
    """Convert a single fact record when it matches the configured source currency.

    Non-destructive: the original amount/currency are preserved untouched, and a
    ``converted`` block plus a ``provenance`` entry are added. Anything that is
    not a matching, numeric, source-currency fact dict is returned unchanged.
    """
    if not isinstance(fact, dict):
        return fact

    amount_field = cfg.get('amount_field') or 'amount'
    currency_field = cfg.get('currency_field') or 'currency'
    source_currency = str(cfg.get('source_currency') or '').strip()
    target_currency = str(cfg.get('target_currency') or '').strip()

    if not source_currency or not target_currency:
        return fact
    if amount_field not in fact or currency_field not in fact:
        return fact

    currency = fact.get(currency_field)
    if not isinstance(currency, str) or currency.strip().upper() != source_currency.upper():
        return fact

    amount = _to_decimal(fact.get(amount_field))
    rate = _to_decimal(cfg.get('rate'))
    if amount is None or rate is None:
        return fact

    try:
        decimals = int(cfg.get('decimals', 2))
    except (TypeError, ValueError):
        decimals = 2

    converted_amount = _quantize(amount * rate, decimals)

    result = dict(fact)
    result['converted'] = {
        'amount': _number(converted_amount),
        'currency': target_currency,
    }

    entry = {
        'op': NODE_OP,
        'rate': _number(rate),
        'rate_date': cfg.get('rate_date', ''),
        'source_currency': source_currency,
        'target_currency': target_currency,
    }

    existing = result.get('provenance')
    if isinstance(existing, list):
        # Copy so we never mutate the caller's list; append our entry.
        result['provenance'] = list(existing) + [entry]
    elif existing is None:
        result['provenance'] = [entry]
    else:
        # Preserve an unexpected non-list provenance rather than clobber it.
        result['provenance'] = [existing, entry]

    return result


def convert_payload(payload: Any, cfg: Dict[str, Any]) -> Any:
    """Apply :func:`convert_fact` to a fact dict or a list of fact dicts.

    Any other payload shape (scalars, strings) is returned unchanged.
    """
    if isinstance(payload, list):
        return [convert_fact(item, cfg) for item in payload]
    if isinstance(payload, dict):
        return convert_fact(payload, cfg)
    return payload
