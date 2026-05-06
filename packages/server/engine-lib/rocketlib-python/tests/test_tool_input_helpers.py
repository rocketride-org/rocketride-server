# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit tests for the tool-input helpers in ``rocketlib.filters``:

* ``normalize_tool_input`` — envelope-strip / input-coercion.
* ``require_str`` / ``require_int`` / ``optional_str`` — argument validators.

These were previously copy-pasted across tool nodes (tool_github,
tool_firecrawl, tool_exa_search, tool_pipe, tool_filesystem); pinning the
shared helpers' contract here means future bug fixes only need to land
in one place.

Run with::

    ./builder rocketlib:test

The ``rocketlib:test`` builder action invokes ``dist/server/engine`` (the
built engine binary) as the Python interpreter, so ``rocketlib`` and its
``engLib`` C extension are importable directly. Tests assume the engine
has been built (``./builder server:build`` runs as a dependency).
"""

from __future__ import annotations

import pytest

from rocketlib import normalize_tool_input, optional_str, require_int, require_str


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
        # The helper does a lazy ``from .engine import warning`` to avoid a
        # circular import at module load. Patch the engine module so we can
        # observe what gets emitted.
        from rocketlib import engine as engine_module

        captured: list[str] = []
        monkeypatch.setattr(engine_module, 'warning', lambda msg: captured.append(msg))

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
