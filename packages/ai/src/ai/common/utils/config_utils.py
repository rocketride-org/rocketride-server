# =============================================================================
# MIT License
#
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

"""
Loose parsers for human-edited node configuration values.

Contract: these helpers read values from a config dict that was likely typed by
a human (in JSON, YAML, or the node-config UI). They accept ``"yes"`` / ``"no"``
/ ``"1"`` / ``"true"`` / ``"on"`` / ``"off"`` style strings because a human is
unlikely to write a JSON boolean by hand.

This is the **opposite** policy of ``ai.common.utils.tool_args``: tool-args
validators (``require_bool`` etc.) reject coerced strings because they validate
LLM output where ``"true"`` instead of ``True`` is a hallucination signal. Do
not unify the two — the strict / loose split is the safety net.
"""

from __future__ import annotations

from typing import Any, Optional


# Sets are case-folded — every callsite lowercases before lookup.
_TRUTHY_STRINGS = frozenset({'1', 'true', 'yes', 'on'})
_FALSY_STRINGS = frozenset({'0', 'false', 'no', 'off'})


def parse_bool(value: Any, default: bool = False) -> bool:
    """Coerce a config value to ``bool``, with loose string handling.

    Used for node configuration values that may have been entered by a
    human in JSON / YAML / the node-config UI, where ``"yes"`` is a likely
    spelling and ``True`` is not.

    Rules:
      * ``None`` → ``default``.
      * ``bool`` → returned as-is.
      * ``str`` → ``"1"`` / ``"true"`` / ``"yes"`` / ``"on"`` (case-insensitive,
        whitespace-stripped) → ``True``; ``"0"`` / ``"false"`` / ``"no"`` /
        ``"off"`` → ``False``; anything else → ``default`` (NOT ``True`` — a
        garbage value is safer to treat as "unspecified" than as truthy).
      * Anything else → ``bool(value)``.

    Args:
        value: The raw config value.
        default: Returned when ``value`` is ``None`` or an unrecognised string.

    Returns:
        A ``bool``.
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalised = value.strip().lower()
        if normalised in _TRUTHY_STRINGS:
            return True
        if normalised in _FALSY_STRINGS:
            return False
        return default
    return bool(value)


def config_int(
    cfg: dict,
    key: str,
    default: int,
    *,
    min_value: Optional[int] = None,
    max_value: Optional[int] = None,
) -> int:
    """Read an integer from a config dict, falling back to ``default``.

    Returns ``default`` when the key is missing, None, non-numeric, or ``<= 0``.
    The result is then clamped to ``[min_value, max_value]`` when those bounds
    are given.

    Note: values ``<= 0`` are treated as "unspecified" and fall back to
    ``default``. This matches the original ``_config_int`` semantics in
    ``tool_http_request`` — node config sliders typically use 0 to mean
    "disabled / use default" rather than as a literal limit.

    Args:
        cfg: The config dict (e.g. from ``Config.getNodeConfig``).
        key: The config key to read.
        default: Returned when the value is missing, invalid, or <= 0.
        min_value: If set, the returned value is at least this. Clamped, not
            rejected — a small misconfiguration should still produce a working
            node.
        max_value: If set, the returned value is at most this. Also clamped.

    Returns:
        The resolved int, optionally clamped to ``[min_value, max_value]``.
    """
    raw = cfg.get(key)
    if raw is None:
        val = default
    else:
        try:
            val = int(raw)
            if val <= 0:
                val = default
        except (TypeError, ValueError):
            val = default
    if min_value is not None:
        val = max(val, min_value)
    if max_value is not None:
        val = min(val, max_value)
    return val
