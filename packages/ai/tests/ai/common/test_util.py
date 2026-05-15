"""
Unit tests for ai.common.util.

Covers the four pure helpers used across the LLM drivers:

- ``normalize`` — collapses whitespace and word-wraps to a max line length.
- ``safeString`` — replaces double quotes with single quotes for prompt-safe context.
- ``parseJson`` — strips ``<think>`` blocks and ```` ```json ```` fences before
  ``json.loads``.
- ``parsePython`` — extracts code from ```` ```python ```` fences.
- ``obfuscate_string`` — keeps the first 4 chars and replaces the tail with ``*``.

``util.py`` does ``from engLib import debug``; engLib is a C-extension bundled
with the engine binary, so the import resolves at test time without mocking.
"""

import pytest

from ai.common import util


# ---------------------------------------------------------------------------
# normalize
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'raw, expected',
    [
        ('hello', 'hello'),
        ('  hello  ', 'hello'),
        ('hello   world', 'hello world'),
        ('  hello   world  ', 'hello world'),
        ('a\nb\tc', 'a b c'),
        ('', ''),
    ],
)
def test_normalize_collapses_whitespace(raw, expected):
    """Leading / trailing / repeated whitespace collapses to single spaces."""
    assert util.normalize(raw) == expected


def test_normalize_wraps_to_max_length():
    """When the collapsed text is longer than max_length, textwrap.fill kicks in."""
    text = 'word ' * 30  # 150 chars before normalising
    out = util.normalize(text, max_length=20)
    # Every wrapped line must be at most max_length characters long.
    for line in out.splitlines():
        assert len(line) <= 20


# ---------------------------------------------------------------------------
# safeString
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value, expected',
    [
        ('hello "world"', "hello 'world'"),
        ('"a" "b"', "'a' 'b'"),
        ('no quotes', 'no quotes'),
        ('  trim me  ', 'trim me'),
        (None, ''),
        (123, '123'),  # non-string is str()'d
    ],
)
def test_safeString_replaces_double_quotes(value, expected):
    """Every " becomes ', the result is stripped, and None becomes ''."""
    assert util.safeString(value) == expected


# ---------------------------------------------------------------------------
# parseJson
# ---------------------------------------------------------------------------


def test_parse_json_plain():
    """A plain JSON string is parsed as-is."""
    assert util.parseJson('{"a": 1}') == {'a': 1}


def test_parse_json_strips_json_fence():
    """A leading ```json fence and the trailing ``` fence are stripped."""
    raw = '```json\n{"a": 1}\n```'
    assert util.parseJson(raw) == {'a': 1}


def test_parse_json_strips_plain_fence():
    """A leading ``` (no language tag) is also stripped."""
    raw = '```\n{"a": 1}\n```'
    assert util.parseJson(raw) == {'a': 1}


def test_parse_json_strips_think_block():
    """Reasoning models emit a <think> block before JSON; it must be removed."""
    raw = '<think>let me decide</think>\n{"answer": 42}'
    assert util.parseJson(raw) == {'answer': 42}


def test_parse_json_strips_think_then_fence():
    """A <think> block followed by a ```json fence is fully unwrapped."""
    raw = '<think>reasoning</think>\n```json\n{"x": "y"}\n```'
    assert util.parseJson(raw) == {'x': 'y'}


def test_parse_json_keeps_inner_backticks_in_string_value():
    """Triple-backticks inside a JSON string value must NOT be treated as fences."""
    raw = '{"answer": "see ```python\\nprint(1)\\n``` here"}'
    parsed = util.parseJson(raw)
    assert parsed == {'answer': 'see ```python\nprint(1)\n``` here'}


def test_parse_json_invalid_raises():
    """Malformed JSON still raises (after the function logs via debug).

    json.JSONDecodeError is a subclass of ValueError, so we pin to that
    base class — narrow enough to catch the right family, broad enough
    to survive a stdlib change of the exact subclass.
    """
    with pytest.raises(ValueError):
        util.parseJson('not json at all')


# ---------------------------------------------------------------------------
# parsePython
# ---------------------------------------------------------------------------


def test_parse_python_extracts_fenced_block():
    """ParsePython returns the code between ```python and the closing ```."""
    raw = 'preamble\n```python\nx = 1\nprint(x)\n```\nepilogue'
    out = util.parsePython(raw)
    assert 'x = 1' in out
    assert 'print(x)' in out
    assert 'preamble' not in out
    assert 'epilogue' not in out


def test_parse_python_returns_input_when_no_fence():
    """If no ```python fence is present the input is returned unchanged."""
    raw = 'just plain text, no fence'
    assert util.parsePython(raw) == raw


# ---------------------------------------------------------------------------
# obfuscate_string
# ---------------------------------------------------------------------------


def test_obfuscate_string_long_keeps_first_four():
    """Strings longer than 4 chars keep the first 4 and replace the rest with stars."""
    assert util.obfuscate_string('abcdefghij') == 'abcd******'


def test_obfuscate_string_exact_four_pads_to_four_stars():
    """A 4-char string keeps all 4 chars and adds zero stars (boundary case)."""
    # len == buffer (4). Falls into the >= branch: first 4 chars, then
    # (len - 4) = 0 stars. Result is the input unchanged.
    assert util.obfuscate_string('abcd') == 'abcd'


@pytest.mark.parametrize(
    'value, expected',
    [
        ('a', 'a***'),
        ('ab', 'ab**'),
        ('abc', 'abc*'),
        ('', '****'),
    ],
)
def test_obfuscate_string_short_pads_with_stars(value, expected):
    """Strings shorter than 4 chars are right-padded with * up to 4 chars."""
    assert util.obfuscate_string(value) == expected
