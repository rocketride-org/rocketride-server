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

import json

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


def test_parse_json_names_a_truncated_think_block():
    """A model cut off mid-reasoning must be told apart from bad JSON.

    The strip regex needs a closing ``</think>``, so a truncated block reaches
    ``json.loads`` intact and fails at character zero. That generic message is
    indistinguishable from a bad schema or a model returning prose, which have
    entirely different fixes -- this one is ``modelOutputTokens``.
    """
    raw = '<think>The user wants a JSON summary. Let me work through the fields one at a'
    with pytest.raises(util.ThinkTruncatedError, match='modelOutputTokens'):
        util.parseJson(raw)


def test_parse_json_names_a_truncated_think_block_after_a_complete_one():
    """The check runs after the substitution, so a trailing truncated block is caught."""
    raw = '<think>first thought</think><think>second one, cut off mid-'
    with pytest.raises(util.ThinkTruncatedError, match='cut off inside a <think> block'):
        util.parseJson(raw)


def test_truncated_think_error_is_still_a_value_error():
    """The dedicated type is what ``chat.py`` branches on; ``ValueError`` is what keeps
    every other caller working.

    ``ChatBase.chat`` needs to fail fast on a budget truncation without string-matching
    the message, but the handlers that predate this class catch ``ValueError`` -- so the
    subclass relationship is part of the contract, not an implementation detail.
    """
    assert issubclass(util.ThinkTruncatedError, ValueError)
    with pytest.raises(ValueError):
        util.parseJson('<think>cut off mid-')


def test_parse_json_does_not_misreport_a_spliced_think_pair():
    """A ``<think>`` opener the substitution left behind is not automatically a truncation.

    ``re.sub`` is a single left-to-right pass, so deleting an inner pair can splice a new
    one into text the pass has already moved past. The result opens with ``<think>`` while
    still carrying its closing tag -- a malformed response, but *not* a budget problem, and
    naming ``modelOutputTokens`` here would send the reader somewhere useless. The
    closing-tag half of the guard is what draws that line.
    """
    raw = '<thi<think>x</think>nk>a</think>{"a": 1}'
    with pytest.raises(json.JSONDecodeError):
        util.parseJson(raw)


@pytest.mark.parametrize(
    'raw',
    [
        '<think>Compare [A, B] and decide which one the user meant',
        '<think>The schema is {title, body}, so I will start with the',
        '<think>Fields {a, b} and options [x, y]; taking them in',
        '<think>I need to emit {"title": ... but first let me check the',
        '<think>consider {"a": 1}; that shape works, so next I will',
        '<think>I will return {"title": "X"} and then add the',
        '<think>I will use option 2',
        '<think>the flag should be true',
    ],
    ids=[
        'bracket',
        'brace',
        'both',
        'partial-json',
        'embedded-fragment',
        'drafted-then-cut',
        'ends-on-number',
        'ends-on-keyword',
    ],
)
def test_parse_json_names_a_truncation_whose_reasoning_mentions_brackets(raw):
    """Reasoning that merely MENTIONS a brace is still a truncation.

    A model reasoning its way toward JSON routinely writes one -- "the schema is
    {title, body}" is an ordinary sentence in that chain. Testing for the character
    would wave through most real truncations, which is the exact failure #1822
    reports. The test is whether a complete JSON value can be *decoded*.
    """
    with pytest.raises(util.ThinkTruncatedError, match='modelOutputTokens'):
        util.parseJson(raw)


@pytest.mark.parametrize(
    'raw',
    [
        '<think>let me reason about the fields\n{"a": 1}',
        '<think>reasoning\n```json\n{"a": 1}\n```',
        '<think>listing them\n[1, 2, 3]',
    ],
    ids=['bare-object', 'fenced-object', 'array'],
)
def test_parse_json_does_not_blame_budget_when_json_actually_arrived(raw):
    """A missing ``</think>`` is not by itself a budget overflow.

    A model can finish its reasoning, emit the JSON, and simply drop the closing tag --
    which happens when the tag is consumed as a stop sequence. The response is still
    unparseable, but ``modelOutputTokens`` is not the fix, and saying so sends the
    operator to a setting that cannot help. These fall through to the ordinary parse
    error instead, exactly as they did before the truncation check existed.
    """
    with pytest.raises(json.JSONDecodeError):
        util.parseJson(raw)


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
