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

"""LLM pricing data and cost calculation utilities.

Prices are per 1 million tokens, sourced from provider pricing pages as of
March 2026.  Custom pricing can be supplied at runtime to override these
defaults.
"""

from typing import Dict, Optional

# ---------------------------------------------------------------------------
# Default pricing table (USD per 1 M tokens)
# ---------------------------------------------------------------------------
PRICING: Dict[str, Dict[str, float]] = {
    'gpt-5': {'input': 2.00, 'output': 8.00},
    'gpt-5.1': {'input': 2.00, 'output': 8.00},
    'gpt-5.2': {'input': 2.00, 'output': 8.00},
    'gpt-5-mini': {'input': 0.40, 'output': 1.60},
    'gpt-5-nano': {'input': 0.10, 'output': 0.40},
    'gpt-4o': {'input': 2.50, 'output': 10.00},
    'gpt-4o-mini': {'input': 0.15, 'output': 0.60},
    'claude-opus': {'input': 15.00, 'output': 75.00},
    'claude-sonnet': {'input': 3.00, 'output': 15.00},
    'claude-haiku': {'input': 0.25, 'output': 1.25},
    'gemini-pro': {'input': 1.25, 'output': 5.00},
    'gemini-flash': {'input': 0.075, 'output': 0.30},
    'mistral-large': {'input': 2.00, 'output': 6.00},
    'mistral-small': {'input': 0.20, 'output': 0.60},
    'deepseek-chat': {'input': 0.14, 'output': 0.28},
    'deepseek-reasoner': {'input': 0.55, 'output': 2.19},
    'perplexity-sonar': {'input': 1.00, 'output': 1.00},
    'ollama': {'input': 0.00, 'output': 0.00},
}


def find_model_pricing(model_name: str, custom_pricing: Optional[Dict[str, Dict[str, float]]] = None) -> Optional[Dict[str, float]]:
    """Return the pricing entry for *model_name* using fuzzy matching.

    Resolution order:
    1. Exact match in *custom_pricing* (if provided).
    2. Exact match in the default ``PRICING`` table.
    3. Prefix / substring match against both tables (custom first).
       For example ``gpt-5.2-preview`` matches ``gpt-5.2``.
    4. ``None`` if nothing matches.
    """
    if not model_name:
        return None

    normalized = model_name.strip().lower()

    # Build merged lookup: custom overrides default (normalize keys to lowercase)
    merged: Dict[str, Dict[str, float]] = dict(PRICING)
    if custom_pricing:
        merged.update({k.strip().lower(): v for k, v in custom_pricing.items()})

    # 1. Exact match
    if normalized in merged:
        return merged[normalized]

    # 2. The model name starts with a known key (longest match wins)
    best_key: Optional[str] = None
    for key in merged:
        if normalized.startswith(key) and (best_key is None or len(key) > len(best_key)):
            best_key = key
    if best_key is not None:
        return merged[best_key]

    # 3. A known key is a substring of the model name (longest match wins)
    best_key = None
    for key in merged:
        if key in normalized and (best_key is None or len(key) > len(best_key)):
            best_key = key
    if best_key is not None:
        return merged[best_key]

    return None


def get_price(model: str, input_tokens: int, output_tokens: int, custom_pricing: Optional[Dict[str, Dict[str, float]]] = None) -> float:
    """Calculate the cost in USD for a single LLM request.

    Args:
        model: Model identifier (e.g. ``'gpt-5'``).
        input_tokens: Number of prompt / input tokens.
        output_tokens: Number of completion / output tokens.
        custom_pricing: Optional per-model overrides.

    Returns:
        Cost in USD.  Returns ``0.0`` when the model is unknown.
    """
    pricing = find_model_pricing(model, custom_pricing)
    if pricing is None:
        return 0.0

    # Clamp negative token counts to zero
    input_tokens = max(0, input_tokens)
    output_tokens = max(0, output_tokens)

    input_cost = (input_tokens / 1_000_000) * pricing['input']
    output_cost = (output_tokens / 1_000_000) * pricing['output']
    return input_cost + output_cost
