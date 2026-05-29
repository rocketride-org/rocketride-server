# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool-input helpers in ``ai.common.utils.tool_args``:

* ``normalize_tool_input`` — envelope-strip / input-coercion.
* ``require_str`` / ``require_int`` / ``require_bool`` — argument validators.
* ``optional_str`` / ``optional_int`` / ``optional_bool`` — optional variants.
* ``validate_tool_input_schema`` — unknown-key rejection.

These were previously copy-pasted across tool nodes (tool_github,
tool_firecrawl, tool_exa_search, tool_pipe, tool_filesystem); pinning the
shared helpers' contract here means future bug fixes only need to land
in one place.

Run with::

    pytest packages/ai/tests/ai/common/utils/test_tool_args.py -v
"""

from __future__ import annotations

import pytest

from ai.common.utils import (
    normalize_tool_input,
    optional_bool,
    optional_int,
    optional_str,
    require_bool,
    require_dict,
    require_int,
    require_str,
    validate_tool_input_schema,
)


# ---------------------------------------------------------------------------
# normalize_tool_input
# ---------------------------------------------------------------------------


class TestNormalizeToolInput:
    def test_none_returns_empty_dict(self):
        assert normalize_tool_input(None) == {}

    def test_plain_dict_passes_through(self):
        assert normalize_tool_input({'a': 1, 'b': 'x'}) == {'a': 1, 'b': 'x'}

    def test_pydantic_like_model_dump(self):
        class Fake:
            def model_dump(self):
                return {'a': 1}

        assert normalize_tool_input(Fake()) == {'a': 1}

    def test_pydantic_v1_dict_fallback(self):
        class FakeV1:
            def dict(self):
                return {'a': 2}

        assert normalize_tool_input(FakeV1()) == {'a': 2}

    def test_pydantic_unwrap_disabled(self):
        class Fake:
            def model_dump(self):
                return {'should': 'not appear'}

        assert normalize_tool_input(Fake(), unwrap_pydantic=False) == {}

    def test_pydantic_model_dump_raises_falls_through(self, monkeypatch):
        # If a buggy pydantic model raises from model_dump(), the helper must
        # not propagate the exception. Falls through to the "unexpected type"
        # branch and returns {} (best-effort contract).
        class FakeBuggy:
            def model_dump(self):
                raise RuntimeError('boom')

        from ai.common.utils import tool_args as tool_args_module

        captured: list[str] = []
        monkeypatch.setattr(tool_args_module, 'warning', lambda msg: captured.append(msg))

        assert normalize_tool_input(FakeBuggy(), tool_name='svc') == {}
        assert any('model_dump' in m for m in captured)

    def test_pydantic_dict_raises_falls_through(self, monkeypatch):
        # Same contract for pydantic v1 .dict() — must not propagate.
        class FakeBuggyV1:
            def dict(self):
                raise RuntimeError('boom')

        from ai.common.utils import tool_args as tool_args_module

        captured: list[str] = []
        monkeypatch.setattr(tool_args_module, 'warning', lambda msg: captured.append(msg))

        assert normalize_tool_input(FakeBuggyV1(), tool_name='svc') == {}
        assert any('dict' in m for m in captured)

    def test_json_string_parsed(self):
        assert normalize_tool_input('{"q": "hello"}') == {'q': 'hello'}

    def test_json_parse_disabled(self):
        assert normalize_tool_input('{"q": "hello"}', parse_json_strings=False) == {}

    def test_unparseable_json_returns_empty(self):
        assert normalize_tool_input('not-json') == {}

    def test_json_string_array_returns_empty(self):
        # Valid JSON, but not a dict — agent-supplied scalars/lists at the
        # tool-args level are nonsense, so we drop them.
        assert normalize_tool_input('[1, 2, 3]') == {}

    def test_unexpected_type_returns_empty(self):
        assert normalize_tool_input(42) == {}
        assert normalize_tool_input([1, 2]) == {}

    def test_nested_input_envelope_unwrapped(self):
        result = normalize_tool_input({'input': {'q': 'hi', 'limit': 5}})
        assert result == {'q': 'hi', 'limit': 5}

    def test_top_level_keys_win_on_conflict(self):
        result = normalize_tool_input({'input': {'q': 'inner'}, 'q': 'outer'})
        assert result == {'q': 'outer'}

    def test_security_context_stripped_by_default(self):
        # ``security_context`` is in the default ``strip_keys`` so callers
        # don't have to opt in to engine-injected-key removal.
        result = normalize_tool_input({'q': 'x', 'security_context': {'user': 'a'}})
        assert result == {'q': 'x'}

    def test_security_context_stripped_from_inside_input_envelope(self):
        result = normalize_tool_input({'input': {'q': 'x', 'security_context': {'user': 'a'}}})
        assert result == {'q': 'x'}

    def test_strip_keys_disabled_keeps_security_context(self):
        # Pass an empty ``strip_keys`` to disable the default stripping —
        # ``security_context`` is preserved verbatim.
        result = normalize_tool_input(
            {'q': 'x', 'security_context': {'user': 'a'}},
            strip_keys=(),
        )
        assert result == {'q': 'x', 'security_context': {'user': 'a'}}

    def test_strip_keys_custom_replaces_default(self):
        # ``strip_keys`` is a replacement, not additive: when the caller
        # supplies their own list, ``security_context`` is no longer
        # stripped unless the caller includes it.
        result = normalize_tool_input(
            {'q': 'x', 'security_context': {'user': 'a'}, 'trace_id': 'abc'},
            strip_keys=('trace_id',),
        )
        assert result == {'q': 'x', 'security_context': {'user': 'a'}}

    def test_strip_keys_can_drop_multiple(self):
        result = normalize_tool_input(
            {'q': 'x', 'security_context': {}, 'trace_id': 'abc', 'session': 'z'},
            strip_keys=('security_context', 'trace_id', 'session'),
        )
        assert result == {'q': 'x'}

    def test_strip_keys_missing_keys_silently_ignored(self):
        # pop(key, None) — listing a key that isn't present is a no-op.
        result = normalize_tool_input({'q': 'x'}, strip_keys=('not_present',))
        assert result == {'q': 'x'}

    def test_non_dict_input_envelope_left_alone(self):
        # If 'input' isn't a dict (e.g. an int), the helper should not crash
        # and should not unwrap — the value stays at the top level.
        result = normalize_tool_input({'input': 5, 'q': 'hi'})
        assert result == {'input': 5, 'q': 'hi'}

    def test_extra_envelope_key_unwrapped(self):
        result = normalize_tool_input(
            {'params': {'q': 'hi', 'n': 3}},
            extra_envelope_keys=('params',),
        )
        assert result == {'q': 'hi', 'n': 3}

    def test_input_envelope_takes_precedence_over_extras(self):
        result = normalize_tool_input(
            {'input': {'a': 1}, 'params': {'b': 2}},
            extra_envelope_keys=('params',),
        )
        assert result == {'a': 1, 'b': 2}

    def test_empty_dict_returns_empty(self):
        assert normalize_tool_input({}) == {}

    def test_does_not_mutate_caller_dict(self):
        # The helper used to pop ``security_context`` from the caller's
        # original dict. Pin the no-side-effects contract so future edits
        # can't reintroduce that.
        original = {'q': 'hi', 'security_context': {'user': 'alice'}}
        snapshot = {'q': 'hi', 'security_context': {'user': 'alice'}}

        result = normalize_tool_input(original)

        assert result == {'q': 'hi'}
        assert original == snapshot, 'normalize_tool_input must not mutate its argument'

    def test_does_not_mutate_caller_dict_via_input_envelope(self):
        # Same guarantee when the envelope-merge path runs: the caller's
        # outer dict and inner ``input`` dict must both be untouched.
        inner = {'q': 'hi'}
        original = {'input': inner, 'security_context': {'user': 'alice'}}

        result = normalize_tool_input(original)

        assert result == {'q': 'hi'}
        assert original == {'input': {'q': 'hi'}, 'security_context': {'user': 'alice'}}
        assert inner == {'q': 'hi'}

    def test_warning_emitted_for_unexpected_type(self, monkeypatch):
        # ``warning`` is imported at module load — patch the local
        # reference in ai.common.utils.tool_args so we can observe what
        # gets emitted.
        from ai.common.utils import tool_args as tool_args_module

        captured: list[str] = []
        monkeypatch.setattr(tool_args_module, 'warning', lambda msg: captured.append(msg))

        result = normalize_tool_input(42, tool_name='exa_search')

        assert result == {}
        assert len(captured) == 1
        assert 'exa_search' in captured[0]
        assert 'int' in captured[0]


# ---------------------------------------------------------------------------
# require_str
# ---------------------------------------------------------------------------


class TestRequireStr:
    def test_returns_stripped_value(self):
        assert require_str({'path': '  /etc/hosts  '}, 'path') == '/etc/hosts'

    def test_accepts_already_clean_value(self):
        assert require_str({'q': 'hello'}, 'q') == 'hello'

    def test_missing_key_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({}, 'path')

    def test_none_value_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': None}, 'path')

    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': ''}, 'path')

    def test_whitespace_only_raises(self):
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': '   '}, 'path')

    def test_non_string_raises(self):
        # The old tool_github helper crashed with AttributeError here; the
        # canonical helper raises a clean ValueError.
        with pytest.raises(ValueError, match='"path" is required'):
            require_str({'path': 42}, 'path')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='file_create: "path" is required'):
            require_str({}, 'path', tool_name='file_create')


# ---------------------------------------------------------------------------
# require_int
# ---------------------------------------------------------------------------


class TestRequireInt:
    def test_int_passes_through(self):
        assert require_int({'n': 42}, 'n') == 42

    def test_numeric_string_coerced(self):
        assert require_int({'n': '42'}, 'n') == 42

    def test_missing_key_raises(self):
        with pytest.raises(ValueError, match='"n" is required'):
            require_int({}, 'n')

    def test_none_value_raises(self):
        with pytest.raises(ValueError, match='"n" is required'):
            require_int({'n': None}, 'n')

    def test_non_numeric_string_raises(self):
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': 'abc'}, 'n')

    def test_bool_rejected(self):
        # bool is an int subclass — agents passing {"issue_number": true}
        # should NOT silently get 1.
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': True}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': False}, 'n')

    def test_float_rejected(self):
        # int(3.7) silently returns 3 — pin the helper against truncation.
        # int(3.0) is also rejected: agents passing fractional notation
        # probably meant a different field, and accepting it would defeat
        # the strict-typing rationale this helper exists for.
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': 3.7}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': 3.0}, 'n')

    def test_inf_and_nan_rejected(self):
        # int(float('inf')) raises OverflowError — make sure callers see a
        # clean ValueError instead of a leaked exception.
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': float('inf')}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': float('nan')}, 'n')

    def test_unsupported_type_rejected(self):
        # Catch-all for non-(int|str) types: lists, dicts, Decimals, etc.
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': [1, 2]}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            require_int({'n': {'x': 1}}, 'n')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='issue_get: "issue_number" is required'):
            require_int({}, 'issue_number', tool_name='issue_get')


# ---------------------------------------------------------------------------
# require_bool
# ---------------------------------------------------------------------------


class TestRequireBool:
    """Strict bool typing. Same safety-net rationale as the rest of the
    require_* family — a coerced string ('true', '1', 'yes') from an LLM
    means hallucinated typing, not a legitimate bool. Surface it as a
    ValueError so the agent self-corrects on the next turn.
    """

    def test_true_passes_through(self):
        assert require_bool({'staged': True}, 'staged') is True

    def test_false_passes_through(self):
        assert require_bool({'staged': False}, 'staged') is False

    def test_missing_key_raises(self):
        with pytest.raises(ValueError, match='"staged" is required'):
            require_bool({}, 'staged')

    def test_none_value_raises(self):
        with pytest.raises(ValueError, match='"staged" is required'):
            require_bool({'staged': None}, 'staged')

    def test_int_rejected(self):
        # No truthy coercion: 1/0 are common LLM hallucinations of bool but
        # strict typing surfaces them as errors so the agent self-corrects.
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': 1}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': 0}, 'staged')

    def test_string_rejected(self):
        # "true"/"false"/"yes"/"1" strings from an LLM are hallucinations.
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': 'true'}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': 'false'}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': '1'}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': ''}, 'staged')

    def test_unsupported_type_rejected(self):
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': [True]}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            require_bool({'staged': {'x': 1}}, 'staged')

    def test_tool_name_prefixes_required_error(self):
        with pytest.raises(ValueError, match='diff: "staged" is required'):
            require_bool({}, 'staged', tool_name='diff')

    def test_tool_name_prefixes_type_error(self):
        with pytest.raises(ValueError, match='diff: "staged" must be a boolean'):
            require_bool({'staged': 'yes'}, 'staged', tool_name='diff')

    def test_no_tool_name_no_prefix(self):
        with pytest.raises(ValueError) as exc:
            require_bool({'staged': 'yes'}, 'staged')
        assert str(exc.value).startswith('"staged"'), f'expected no prefix, got: {exc.value!r}'

    def test_does_not_mutate_args(self):
        args = {'staged': True}
        snapshot = dict(args)
        require_bool(args, 'staged')
        assert args == snapshot


# ---------------------------------------------------------------------------
# optional_str
# ---------------------------------------------------------------------------


class TestOptionalStr:
    def test_returns_value_when_present(self):
        assert optional_str({'encoding': 'latin-1'}, 'encoding') == 'latin-1'

    def test_returns_default_when_missing(self):
        assert optional_str({}, 'encoding', default='utf-8') == 'utf-8'

    def test_returns_non_string_default_untouched_when_missing(self):
        # Type validation must not fire on the absent path — otherwise
        # callers passing a non-string sentinel as default would get
        # rejected for an arg they didn't supply.
        sentinel = object()
        assert optional_str({}, 'encoding', default=sentinel) is sentinel
        assert optional_str({}, 'encoding', default=0) == 0

    def test_returns_default_when_none(self):
        assert optional_str({'encoding': None}, 'encoding', default='utf-8') == 'utf-8'

    def test_default_defaults_to_none(self):
        assert optional_str({}, 'encoding') is None

    def test_does_not_strip(self):
        # Unlike require_str, optional_str preserves the value as-is — an
        # explicit empty string stays empty.
        assert optional_str({'encoding': ''}, 'encoding') == ''

    def test_non_string_raises(self):
        with pytest.raises(ValueError, match='"encoding" must be a string'):
            optional_str({'encoding': 42}, 'encoding')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='read_file: "encoding" must be a string'):
            optional_str({'encoding': 42}, 'encoding', tool_name='read_file')


# ---------------------------------------------------------------------------
# optional_int
# ---------------------------------------------------------------------------


class TestOptionalInt:
    """Mirrors TestOptionalStr's coverage where applicable, plus the
    require_int-shaped type and bounds rules.
    """

    def test_returns_value_when_present(self):
        assert optional_int({'max_count': 42}, 'max_count') == 42

    def test_numeric_string_coerced(self):
        # Same as require_int — accept string-encoded ints.
        assert optional_int({'n': '42'}, 'n') == 42

    def test_returns_default_when_missing(self):
        assert optional_int({}, 'max_count', default=20) == 20

    def test_returns_default_when_none(self):
        # JSON null deserialises to Python None — treat it the same as
        # an absent key (the agent explicitly chose to not specify).
        assert optional_int({'max_count': None}, 'max_count', default=20) == 20

    def test_default_defaults_to_none(self):
        assert optional_int({}, 'max_count') is None

    def test_returns_non_int_default_untouched_when_missing(self):
        # Same rationale as optional_str: ``default`` is author-supplied at
        # call time; validating it would reject perfectly legitimate sentinel
        # values.
        sentinel = object()
        assert optional_int({}, 'n', default=sentinel) is sentinel
        assert optional_int({}, 'n', default='unset') == 'unset'

    def test_default_not_range_checked(self):
        # When the key is absent, the default is returned unchanged even
        # if it falls outside [lo, hi]. An out-of-range default is an
        # author bug at call site, not an agent bug at runtime.
        assert optional_int({}, 'max_count', default=999, lo=1, hi=200) == 999
        assert optional_int({}, 'max_count', default=-5, lo=0, hi=10) == -5

    def test_lo_lower_bound_inclusive(self):
        # lo is inclusive, matches require_int.
        assert optional_int({'n': 1}, 'n', lo=1, hi=200) == 1
        with pytest.raises(ValueError, match='"n" must be an integer between 0 and 200'):
            optional_int({'n': -1}, 'n', lo=0, hi=200)

    def test_hi_upper_bound_inclusive(self):
        # hi is inclusive, matches require_int.
        assert optional_int({'n': 200}, 'n', lo=1, hi=200) == 200
        with pytest.raises(ValueError, match='"n" must be an integer between 1 and 200'):
            optional_int({'n': 201}, 'n', lo=1, hi=200)

    def test_lo_alone_rejects_below_only(self):
        # Only lo set: arbitrarily-large values pass; anything below lo fails.
        assert optional_int({'n': 10**9}, 'n', lo=1) == 10**9
        with pytest.raises(ValueError, match='"n" must be an integer >= 1'):
            optional_int({'n': 0}, 'n', lo=1)

    def test_hi_alone_rejects_above_only(self):
        # Only hi set: arbitrarily-negative values pass; anything above hi fails.
        assert optional_int({'n': -(10**9)}, 'n', hi=200) == -(10**9)
        with pytest.raises(ValueError, match='"n" must be an integer <= 200'):
            optional_int({'n': 999}, 'n', hi=200)

    def test_no_bounds_accepts_any_int(self):
        # No lo or hi → only type validation, no range check.
        assert optional_int({'n': 10**18}, 'n') == 10**18
        assert optional_int({'n': -(10**18)}, 'n') == -(10**18)

    def test_bool_rejected(self):
        # Same as require_int: bool is technically an int but agent intent
        # is almost certainly different.
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': True}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': False}, 'n')

    def test_float_rejected(self):
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': 3.7}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': 3.0}, 'n')

    def test_non_numeric_string_raises(self):
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': 'abc'}, 'n')

    def test_unsupported_type_rejected(self):
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': [1, 2]}, 'n')
        with pytest.raises(ValueError, match='"n" must be an integer'):
            optional_int({'n': {'x': 1}}, 'n')

    def test_tool_name_prefixes_error_on_present_value(self):
        with pytest.raises(ValueError, match='log: "max_count" must be an integer'):
            optional_int({'max_count': 'abc'}, 'max_count', tool_name='log')

    def test_tool_name_prefixes_range_error(self):
        with pytest.raises(ValueError, match='log: "max_count" must be an integer between 1 and 200'):
            optional_int({'max_count': 999}, 'max_count', lo=1, hi=200, tool_name='log')

    def test_does_not_mutate_args(self):
        # Pure inspection — no setdefault, no pop.
        args = {'max_count': 42}
        snapshot = dict(args)
        optional_int(args, 'max_count', default=20, lo=1, hi=200)
        assert args == snapshot


# ---------------------------------------------------------------------------
# optional_bool
# ---------------------------------------------------------------------------


class TestOptionalBool:
    """Mirrors TestOptionalStr / TestOptionalInt — strict bool typing,
    default returned untouched on the absent path.
    """

    def test_returns_value_when_present(self):
        assert optional_bool({'staged': True}, 'staged') is True
        assert optional_bool({'staged': False}, 'staged') is False

    def test_returns_default_when_missing(self):
        assert optional_bool({}, 'staged', default=False) is False
        assert optional_bool({}, 'staged', default=True) is True

    def test_returns_default_when_none(self):
        # JSON null → Python None → use default.
        assert optional_bool({'staged': None}, 'staged', default=False) is False
        assert optional_bool({'staged': None}, 'staged', default=True) is True

    def test_default_defaults_to_none(self):
        assert optional_bool({}, 'staged') is None

    def test_returns_non_bool_default_untouched_when_missing(self):
        # Mirrors optional_str/optional_int: ``default`` is author-supplied
        # at call time; validating it would reject legitimate sentinels.
        sentinel = object()
        assert optional_bool({}, 'staged', default=sentinel) is sentinel
        assert optional_bool({}, 'staged', default='unset') == 'unset'
        assert optional_bool({}, 'staged', default=0) == 0

    def test_int_rejected(self):
        # No truthy coercion: 1/0 are common LLM hallucinations of bool but
        # strict typing surfaces them as errors so the agent self-corrects.
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': 1}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': 0}, 'staged')

    def test_string_rejected(self):
        # Same rationale — "true"/"false" strings are LLM hallucinations.
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': 'true'}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': 'false'}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': ''}, 'staged')

    def test_unsupported_type_rejected(self):
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': [True]}, 'staged')
        with pytest.raises(ValueError, match='"staged" must be a boolean'):
            optional_bool({'staged': {'x': 1}}, 'staged')

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='diff: "staged" must be a boolean'):
            optional_bool({'staged': 'yes'}, 'staged', tool_name='diff')

    def test_no_tool_name_no_prefix(self):
        with pytest.raises(ValueError) as exc:
            optional_bool({'staged': 'yes'}, 'staged')
        assert str(exc.value).startswith('"staged"'), f'expected no prefix, got: {exc.value!r}'

    def test_does_not_mutate_args(self):
        # Pure inspection.
        args = {'staged': True}
        snapshot = dict(args)
        optional_bool(args, 'staged', default=False)
        assert args == snapshot

    def test_present_overrides_default(self):
        # Belt-and-suspenders: when the agent explicitly sends False with
        # default=True, we return False. The "absent" path is None / missing,
        # not False.
        assert optional_bool({'staged': False}, 'staged', default=True) is False


# ---------------------------------------------------------------------------
# require_dict
# ---------------------------------------------------------------------------


class TestRequireDict:
    def test_dict_passes_through(self):
        d = {'a': 1}
        assert require_dict(d) is d

    def test_empty_dict_accepted(self):
        d: dict = {}
        assert require_dict(d) is d

    def test_non_dict_raises(self):
        with pytest.raises(ValueError, match='Tool input must be a JSON object'):
            require_dict('hello')
        with pytest.raises(ValueError, match='Tool input must be a JSON object'):
            require_dict(42)
        with pytest.raises(ValueError, match='Tool input must be a JSON object'):
            require_dict([1, 2])
        with pytest.raises(ValueError, match='Tool input must be a JSON object'):
            require_dict(None)

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='read_file: Tool input must be a JSON object'):
            require_dict('hello', tool_name='read_file')


# ---------------------------------------------------------------------------
# validate_tool_input_schema
# ---------------------------------------------------------------------------


class TestValidateToolInputSchema:
    """Unknown-key rejection against an ``@tool_function`` input schema.

    The schema declared on ``@tool_function`` is documentation-only — the
    framework dispatches without enforcing it. Tool nodes that want runtime
    rejection of hallucinated parameter names (the ``include_remote`` bug
    class) call this helper to opt in.
    """

    # Reusable schemas
    _BRANCH_LIST = {
        'type': 'object',
        'required': [],
        'properties': {
            'remote': {'type': 'boolean'},
            'all_branches': {'type': 'boolean'},
        },
    }
    _STATUS = {'type': 'object', 'properties': {}, 'required': []}

    def test_empty_args_against_empty_schema_passes(self):
        # Both empty — nothing to flag.
        assert validate_tool_input_schema(self._STATUS, {}) is None

    def test_empty_args_against_populated_schema_passes(self):
        # No keys to flag — schema's allowed list is irrelevant when args is empty.
        assert validate_tool_input_schema(self._BRANCH_LIST, {}) is None

    def test_all_known_keys_pass(self):
        assert validate_tool_input_schema(self._BRANCH_LIST, {'remote': True}) is None
        assert (
            validate_tool_input_schema(
                self._BRANCH_LIST,
                {'remote': True, 'all_branches': False},
            )
            is None
        )

    def test_single_unknown_key_lists_allowed(self):
        # The production bug from PR #731: agent sent ``include_remote``,
        # the schema declares ``remote``. Helper must surface both the bad
        # key and the allowed list.
        with pytest.raises(ValueError) as exc:
            validate_tool_input_schema(self._BRANCH_LIST, {'include_remote': True})
        msg = str(exc.value)
        assert "['include_remote']" in msg
        assert "'remote'" in msg
        assert "'all_branches'" in msg

    def test_multiple_unknown_keys_sorted(self):
        # Sorted output makes the error stable across Python dict-ordering
        # changes and easier for an agent's prompt to parse.
        with pytest.raises(ValueError) as exc:
            validate_tool_input_schema(
                self._BRANCH_LIST,
                {'zebra': 1, 'alpha': 2, 'mango': 3},
            )
        assert "['alpha', 'mango', 'zebra']" in str(exc.value)

    def test_unknown_alongside_known(self):
        # Mixed args: one valid, one bogus. Only the bogus one is reported.
        with pytest.raises(ValueError) as exc:
            validate_tool_input_schema(
                self._BRANCH_LIST,
                {'remote': True, 'bogus': 'x'},
            )
        msg = str(exc.value)
        assert "['bogus']" in msg
        assert 'remote' not in msg.split("['")[1]  # 'remote' only appears in the allowed list, not unknown

    def test_no_args_tool_with_extra_keys_special_message(self):
        # When the schema declares zero properties, the error reads
        # "this tool takes no parameters" instead of the allowed-list
        # form. Distinct phrasing helps an agent recognise the
        # "you sent args, none accepted" case.
        with pytest.raises(ValueError, match='this tool takes no parameters'):
            validate_tool_input_schema(self._STATUS, {'foo': 1})

    def test_missing_properties_key_treated_as_no_args(self):
        # A schema with no ``properties`` key (uncommon, but legal JSON
        # Schema) is treated identically to ``properties: {}``.
        with pytest.raises(ValueError, match='this tool takes no parameters'):
            validate_tool_input_schema({'type': 'object'}, {'foo': 1})

    def test_properties_explicitly_none_treated_as_no_args(self):
        # Defensive: ``schema.get('properties') or {}`` collapses None to
        # empty so a malformed schema doesn't crash with AttributeError.
        with pytest.raises(ValueError, match='this tool takes no parameters'):
            validate_tool_input_schema({'properties': None}, {'foo': 1})

    def test_empty_input_schema_passes_when_args_empty(self):
        # Truly empty schema + empty args → no-op, even though the schema
        # has no ``properties`` key at all.
        assert validate_tool_input_schema({}, {}) is None

    def test_tool_name_prefixes_error(self):
        with pytest.raises(ValueError, match='branch_list: unknown parameter'):
            validate_tool_input_schema(
                self._BRANCH_LIST,
                {'include_remote': True},
                tool_name='branch_list',
            )

    def test_tool_name_prefixes_no_args_message(self):
        with pytest.raises(ValueError, match='status: this tool takes no parameters'):
            validate_tool_input_schema(self._STATUS, {'foo': 1}, tool_name='status')

    def test_no_tool_name_no_prefix(self):
        # Empty tool_name (default) — error starts directly with the
        # subject, no leading ``: ``.
        with pytest.raises(ValueError) as exc:
            validate_tool_input_schema(self._BRANCH_LIST, {'bogus': 1})
        msg = str(exc.value)
        assert msg.startswith('unknown parameter'), f'expected no prefix, got: {msg!r}'

    def test_does_not_mutate_args(self):
        # Pure inspection — the helper must not pop the unknown keys it
        # reports (caller may want to log them).
        args = {'remote': True, 'bogus': 1}
        snapshot = dict(args)
        with pytest.raises(ValueError):
            validate_tool_input_schema(self._BRANCH_LIST, args)
        assert args == snapshot

    def test_does_not_mutate_schema(self):
        # Defensive: ensure we never .pop() or otherwise touch the schema
        # the caller passed in (it's typically a frozen module-level dict
        # used by every call).
        schema_snapshot = {
            'type': 'object',
            'required': [],
            'properties': {
                'remote': {'type': 'boolean'},
                'all_branches': {'type': 'boolean'},
            },
        }
        validate_tool_input_schema(self._BRANCH_LIST, {'remote': True})
        assert self._BRANCH_LIST == schema_snapshot
