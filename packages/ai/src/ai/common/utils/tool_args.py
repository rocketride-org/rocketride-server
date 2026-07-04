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
Strict validators and envelope normalisation for LLM-supplied tool args.

Contract: these helpers validate tool arguments that come from an agent / LLM.
They are deliberately strict about types — ``require_bool`` does not coerce
``"true"`` to ``True``, ``require_int`` does not accept ``bool``. The reason
is that a coerced value almost always signals a model hallucination, and a
clean ``ValueError`` lets the agent self-correct on the next turn instead of
producing a wrong result silently.

For loose parsing of human-edited config files (where ``"yes"`` / ``"1"`` /
``"on"`` should all be accepted), use ``ai.common.utils.config_utils.parse_bool``
instead. The strict vs loose split is intentional — see
``packages/ai/src/ai/common/utils/config_utils.py``.

Tool nodes used to ship private ``_require_str`` / ``_require_int`` /
``_optional_str`` helpers with subtly inconsistent semantics. Centralising
them here lets every tool node get the same validation behaviour and leaves
room to fix bugs in one place.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Iterable, Optional

from rocketlib import warning


# =========================================================================
# Tool input normalisation
#
# Agents call tools with payloads that the engine's invoke pipeline can
# deliver in several shapes — plain dicts, Pydantic models, JSON strings,
# or wrapped envelopes such as {"input": {...}, "security_context": ...}.
# Every tool node used to ship its own copy of this normalisation
# function; consolidating into one canonical helper means bug fixes and
# behaviour decisions live in one place.
# =========================================================================


def normalize_tool_input(
    input_obj: Any,
    *,
    extra_envelope_keys: Iterable[str] = (),
    strip_keys: Iterable[str] = ('security_context',),
    parse_json_strings: bool = True,
    unwrap_pydantic: bool = True,
    tool_name: str = 'tool',
) -> Dict[str, Any]:
    """Coerce agent-supplied tool input to a plain args dict.

    Handles, in order:
      1. ``None`` -> ``{}``
      2. Pydantic model unwrap (via ``model_dump()`` / ``dict()``) when
         ``unwrap_pydantic`` is True.
      3. JSON-string parse when ``parse_json_strings`` is True. A string
         that does not parse to a dict is left unchanged (and falls through
         to the unexpected-type branch below).
      4. Anything still not a dict -> ``{}`` after a ``warning(...)``.
      5. Nested envelope unwrap: any of ``('input', *extra_envelope_keys)``
         whose value is a dict is merged into the top level. Top-level keys
         win on conflict (so a sibling key beside the envelope overrides
         the one inside it).
      6. Strip every key listed in ``strip_keys``.

    Args:
        input_obj: Raw tool input as delivered by the engine's invoke chain.
        extra_envelope_keys: Additional keys that, like ``input``, wrap the
            real arguments and should be unwrapped/merged.
        strip_keys: Keys to drop from the final dict before returning.
            Defaults to ``('security_context',)`` — engine-injected and
            never a tool arg. Pass ``()`` to disable stripping, or a list
            to add more (e.g. ``('security_context', 'trace_id')``).
        parse_json_strings: Try ``json.loads`` on string inputs. Set False
            for tools where the engine path is known never to deliver a
            JSON-encoded string.
        unwrap_pydantic: Call ``model_dump()`` / ``dict()`` on objects that
            expose them. Set False for tools where the engine path never
            delivers a Pydantic instance.
        tool_name: Short identifier prefixed onto warning messages so
            unexpected-input traces are attributable to a specific node.

    Returns:
        A plain ``dict`` of normalised tool arguments. Returns ``{}`` for
        inputs that cannot be coerced (e.g. integers, lists, malformed
        JSON), after emitting a warning.
    """
    if input_obj is None:
        return {}

    if unwrap_pydantic:
        # Best-effort unwrap. A buggy pydantic model whose ``model_dump`` /
        # ``dict`` raises must not break tool invocation — warn and continue
        # with the original object; the next branch will fall through to
        # the "unexpected type" warning + ``{}`` return path.
        model_dump = getattr(input_obj, 'model_dump', None)
        if callable(model_dump):
            try:
                input_obj = model_dump()
            except Exception:
                warning(f'{tool_name}: model_dump() raised during input normalisation')
        else:
            as_dict = getattr(input_obj, 'dict', None)
            if callable(as_dict):
                try:
                    input_obj = as_dict()
                except Exception:
                    warning(f'{tool_name}: dict() raised during input normalisation')

    if parse_json_strings and isinstance(input_obj, str):
        try:
            parsed = json.loads(input_obj)
        except (json.JSONDecodeError, TypeError):
            parsed = None
        if isinstance(parsed, dict):
            input_obj = parsed

    if not isinstance(input_obj, dict):
        warning(f'{tool_name}: unexpected input type {type(input_obj).__name__}')
        return {}

    # Shallow-copy so the envelope-merge and the strip_keys pop below
    # never mutate a caller-owned dict.
    input_obj = dict(input_obj)

    for key in ('input', *extra_envelope_keys):
        wrapped = input_obj.get(key)
        if isinstance(wrapped, dict):
            extras = {k: v for k, v in input_obj.items() if k != key}
            input_obj = {**wrapped, **extras}

    for key in strip_keys:
        input_obj.pop(key, None)
    return input_obj


# =========================================================================
# Tool argument validators
# =========================================================================


def require_str(args: Dict[str, Any], key: str, *, tool_name: str = '') -> str:
    """Return ``args[key]`` as a non-empty stripped string, or raise ValueError.

    Args:
        args: The normalised tool args dict (typically the output of
            :func:`normalize_tool_input`).
        key: The required argument name.
        tool_name: Short identifier prefixed onto error messages — usually
            the tool function name (``'file_create'``) or node name
            (``'tool_github'``). Empty string omits the prefix.

    Raises:
        ValueError: If ``key`` is missing, not a string, or is empty/whitespace.
    """
    val = args.get(key)
    if not isinstance(val, str) or not val.strip():
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" is required and must be a non-empty string')
    return val.strip()


def require_int(
    args: Dict[str, Any],
    key: str,
    *,
    lo: Optional[int] = None,
    hi: Optional[int] = None,
    tool_name: str = '',
) -> int:
    """Return ``args[key]`` coerced to ``int``, or raise ValueError.

    Accepts plain ints and numeric strings. The following are rejected with
    a ValueError instead of being silently coerced:

    * ``bool`` — despite being an ``int`` subclass, ``{"issue_number": true}``
      almost never means ``1``.
    * ``float`` — ``int(3.7)`` would truncate to ``3``, and ``inf`` / ``nan``
      would leak an ``OverflowError`` / ``ValueError`` from ``int()``.
    * Any other non-(int|str) type, e.g. lists, dicts, ``Decimal``.

    Optional bounds:

    * ``lo`` — if set, the value must be ``>= lo``.
    * ``hi`` — if set, the value must be ``<= hi``.
    * Both — the value must lie in ``[lo, hi]``.
    * Neither — no range check.

    The error message advertises the configured bounds so the agent can
    see what range it should retry within.
    """
    prefix = f'{tool_name}: ' if tool_name else ''
    val = args.get(key)
    if val is None:
        raise ValueError(f'{prefix}"{key}" is required')
    # bool is an int subclass and float would truncate — keep str and real
    # int as the only inputs that reach the coercion below. OverflowError
    # is also caught for defence-in-depth (e.g. ``int('1' * 10**6)`` is
    # technically valid but takes minutes; an opaque traceback would be
    # worse than the friendly message).
    if isinstance(val, (bool, float)) or not isinstance(val, (int, str)):
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    try:
        out = int(val)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    if lo is not None and out < lo:
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    if hi is not None and out > hi:
        raise ValueError(f'{prefix}"{key}" must be an integer{_range_phrase(lo, hi)}')
    return out


def _range_phrase(lo: Optional[int], hi: Optional[int]) -> str:
    """Render ' between LO and HI' / ' >= LO' / ' <= HI' / ''."""
    if lo is not None and hi is not None:
        return f' between {lo} and {hi}'
    if lo is not None:
        return f' >= {lo}'
    if hi is not None:
        return f' <= {hi}'
    return ''


def require_bool(args: Dict[str, Any], key: str, *, tool_name: str = '') -> bool:
    """Return ``args[key]`` as ``bool``, or raise ValueError.

    Strict on type to keep agent intent unambiguous. Accepts ``True`` and
    ``False`` only — no truthy coercion of ``1``/``0``/``"true"``/``"false"``,
    because schemas declared ``"type": "boolean"`` mean exactly that and
    a coerced string smells like an LLM hallucination worth flagging.

    For optional booleans (typical schema default), call
    ``args.setdefault(key, <default>)`` before this helper.
    """
    prefix = f'{tool_name}: ' if tool_name else ''
    val = args.get(key)
    if val is None:
        raise ValueError(f'{prefix}"{key}" is required')
    if not isinstance(val, bool):
        raise ValueError(f'{prefix}"{key}" must be a boolean')
    return val


def validate_tool_input_schema(
    input_schema: Dict[str, Any],
    args: Dict[str, Any],
    *,
    tool_name: str = '',
) -> None:
    """Reject any *args* keys not declared in ``input_schema['properties']``.

    Without this check, a hallucinated parameter name (e.g. ``include_remote``
    instead of the schema's ``remote``) is silently dropped by the dispatcher
    and the call returns a default-valued result the agent then misreads —
    "this tool doesn't support remotes" — and gives up. Raising a clean
    ValueError that names the bad key and lists the allowed ones lets the
    agent self-correct on the next turn.

    The framework's ``@tool_function`` only uses ``input_schema`` to build
    the ``tool.query`` descriptor; runtime validation is opt-in via this
    helper. Pair it with :func:`normalize_tool_input` for the typical
    "strip envelope, then validate" pattern at tool-method entry.

    Args:
        input_schema: The JSON-schema-shaped dict that's also passed to
            ``@tool_function``. Only ``input_schema['properties']`` is
            consulted; missing or ``None`` is treated as "no allowed keys".
        args: The (already-normalised) tool arguments dict.
        tool_name: Short identifier prefixed onto error messages so an
            agent looking at multiple errors can attribute each to the
            specific tool. Empty string omits the prefix.

    Raises:
        ValueError: If ``args`` contains any key not in
            ``input_schema['properties']``. The message lists the unknown
            keys and the allowed ones (or "this tool takes no parameters"
            for schemas with empty properties).
    """
    allowed = set((input_schema.get('properties') or {}).keys())
    unknown = sorted(k for k in args if k not in allowed)
    if not unknown:
        return
    prefix = f'{tool_name}: ' if tool_name else ''
    if allowed:
        raise ValueError(f'{prefix}unknown parameter(s) {unknown}. Allowed parameters: {sorted(allowed)}.')
    raise ValueError(f'{prefix}this tool takes no parameters; received unexpected: {unknown}.')


def optional_bool(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    tool_name: str = '',
) -> Any:
    """Return ``args[key]`` as ``bool``, or ``default`` if absent/None.

    Type rules mirror :func:`require_bool` exactly when the key is present
    (strict ``True`` / ``False`` only — no truthy coercion of ``1``/``0``/
    ``"true"``). The only difference is the absent-key path: instead of
    raising "is required", ``default`` is returned.

    Following :func:`optional_str`: type validation only fires when ``key``
    is present. ``default`` is returned untouched on the absent path so
    callers can use non-bool sentinels (e.g. ``object()``, ``None``) without
    the helper rejecting them.

    Args:
        args: The (already-normalised) tool arguments dict.
        key: The optional argument name.
        default: Value to return when ``key`` is missing or its value is None.
            Defaults to ``None``. Returned untouched — the helper does NOT
            type-check the default; an unusual default is an author-side
            choice, not an agent-side bug.
        tool_name: Short identifier prefixed onto error messages.

    Raises:
        ValueError: If ``key`` is present with a non-bool value.
    """
    if key not in args:
        return default
    val = args[key]
    if val is None:
        return default
    if not isinstance(val, bool):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" must be a boolean')
    return val


def optional_int(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    lo: Optional[int] = None,
    hi: Optional[int] = None,
    tool_name: str = '',
) -> Any:
    """Return ``args[key]`` coerced to ``int``, or ``default`` if absent/None.

    Type and bounds rules mirror :func:`require_int` exactly when the key is
    present (bool / float / unsupported types rejected; optional ``lo`` / ``hi``
    inclusive bounds checked). The only difference is the absent-key path:
    instead of raising "is required", ``default`` is returned.

    Following :func:`optional_str`: type and bounds validation only fires
    when ``key`` is present. ``default`` is returned untouched on the absent
    path so callers can use non-int sentinels (e.g. ``object()``) without
    the helper rejecting them.

    Args:
        args: The (already-normalised) tool arguments dict.
        key: The optional argument name.
        default: Value to return when ``key`` is missing or its value is None.
            Defaults to ``None``. Returned untouched — the helper does NOT
            range-check the default; an out-of-range default is an
            author-side bug, not an agent-side bug.
        lo: If set, the value (when present) must be ``>= lo``.
        hi: If set, the value (when present) must be ``<= hi``.
        tool_name: Short identifier prefixed onto error messages so a
            multi-tool dispatcher can attribute each error to a tool.

    Raises:
        ValueError: If ``key`` is present with a non-int value, or with an
            int outside the configured ``[lo, hi]`` bounds.
    """
    if key not in args:
        return default
    val = args[key]
    if val is None:
        return default
    # Reuse require_int's type + range machinery so the validation rules
    # stay in sync between required and optional variants.
    return require_int({key: val}, key, lo=lo, hi=hi, tool_name=tool_name)


def require_dict(args: Any, *, tool_name: str = '') -> Dict[str, Any]:
    """Return ``args`` if it is a dict; otherwise raise ValueError.

    Trivial type guard used at the entry of tool methods that expect a JSON
    object payload. Use this when ``normalize_tool_input`` would be overkill
    (e.g. the input is already known to be coercion-free) but a clean error
    on non-dict input is still required.

    Args:
        args: The raw tool input.
        tool_name: Short identifier prefixed onto error messages.

    Raises:
        ValueError: If ``args`` is not a dict.
    """
    if not isinstance(args, dict):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}Tool input must be a JSON object (dict)')
    return args


def optional_str(
    args: Dict[str, Any],
    key: str,
    *,
    default: Any = None,
    tool_name: str = '',
) -> Any:
    """Return ``args[key]`` as a string, or ``default`` if absent/None.

    Raises ValueError if ``key`` is present but the value is not a string.
    Unlike :func:`require_str`, the returned value is **not** stripped — an
    explicitly-supplied "" stays "".

    Type validation only fires when ``key`` is present with a non-string
    value. A non-string ``default`` is returned untouched on the absent
    path — validating ``default`` would mean the helper rejects perfectly
    legitimate ``optional_str(args, 'n', default=0)`` calls.
    """
    if key not in args:
        return default
    val = args[key]
    if val is None:
        return default
    if not isinstance(val, str):
        prefix = f'{tool_name}: ' if tool_name else ''
        raise ValueError(f'{prefix}"{key}" must be a string')
    return val
