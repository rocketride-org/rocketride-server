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


@pytest.mark.parametrize(
    ('raw', 'expected'),
    [
        ('Here is my plan:\n```json\n{"a": 1}\n```\nHope that helps!', {'a': 1}),
        ('Sure.\n```json\n[1, 2]\n```', [1, 2]),
        ('```json\n{"a": 1}\n```\nLet me know if you need more.', {'a': 1}),
        ('{"a": 1}\n\nThis plan reads the file first.', {'a': 1}),
        (
            'I\'ll create the package and tests.{"thought": "write", "tool_calls": []}',
            {'thought': 'write', 'tool_calls': []},
        ),
        ('Step [1/3]: read the stylesheet.\n```json\n{"a": 1}\n```', {'a': 1}),
        ('I\'ll embed it with {{memory.ref:wave-0.r0:markdown_table}}.\n```json\n{"a": 1}\n```', {'a': 1}),
        ('```json\n{"a": 1}\n```\n\n1. Read the stylesheet first.', {'a': 1}),
        ('Here is the plan:\n```\n{"a": 1}\n```', {'a': 1}),
        ('{"a": 1}\n\n2) Then compile the project.', {'a': 1}),
        ('{"a": 1}\nNote: the stylesheet is read first.', {'a': 1}),
    ],
    ids=[
        'sentence-around-fence',
        'sentence-before-fence',
        'remark-after-fence',
        'remark-after-object',
        'sentence-then-bare-object',
        'bracket-in-prose-before-fence',
        'memory-ref-tag-before-fence',
        'numbered-remark-after-fence',
        'sentence-then-plain-fence',
        'numbered-remark-with-a-parenthesis',
        'remark-with-a-label',
    ],
)
def test_parse_json_reads_a_reply_wrapped_in_prose(raw, expected):
    """A polite sentence around the JSON is not a broken reply.

    Each of these used to fail the parse, and ChatBase.chat then paid a repair round
    trip for a reply that held valid JSON all along.
    """
    assert util.parseJson(raw) == expected


def test_parse_json_keeps_backticks_inside_a_prose_wrapped_reply():
    """A code fence inside a JSON string is data, not the end of the block."""
    raw = 'Here you go:\n```json\n{"done": true, "answer": "Use ```python\\nprint(1)\\n``` here"}\n```\nDone.'

    assert util.parseJson(raw) == {'done': True, 'answer': 'Use ```python\nprint(1)\n``` here'}


def test_parse_json_never_takes_a_draft_from_unfinished_reasoning():
    """Prose, then a <think> block that never closes: a JSON fence inside it is a draft, not the answer."""
    draft = '{"tool_calls": [{"tool": "workspace.write", "args": {"path": "a", "content": "draft"}}]}'
    raw = f'Preface\n<think>Considering this plan:\n```json\n{draft}\n```\nbut maybe'

    with pytest.raises(ValueError):
        util.parseJson(raw)


@pytest.mark.parametrize(
    'raw',
    [
        '{"tool_calls": [{"tool": "workspace.write"}]}\n<think>Actually, I should reconsider this write',
        '```json\n{"tool_calls": [{"tool": "workspace.write"}]}\n```\n<think>Actually, wait',
    ],
    ids=['bare', 'fenced'],
)
def test_parse_json_rejects_a_value_followed_by_unfinished_reasoning(raw):
    """JSON, then reasoning that never closes: the model may be reconsidering it, so it is a draft."""
    with pytest.raises(ValueError):
        util.parseJson(raw)


def test_parse_json_ignores_an_example_object_in_the_middle_of_prose():
    """An object followed by more prose is an example, not the reply."""
    with pytest.raises(ValueError):
        util.parseJson('The reply looks like {"done": true}, and I will write it next.')


@pytest.mark.parametrize(
    'raw',
    [
        '[{"name": "Alice"}], {"name": "Bob"}]',
        '{"a": 1} {"b": 2}',
        '{"a": 1}, and {"b": 2} is the other option.',
        '{"a": 1} 42',
        '{"a": 1}\ntrue',
        'Here:\n```json\n[{"name": "Alice"}], {"name": "Bob"}]\n```',
        'Plan A:\n```json\n{"a": 1}\n```\nPlan B:\n```json\n{"b": 2}\n```',
        'Here are the rows: [{"name": "Alice"}], [{"name": "Bob"}]',
        'Two objects: {"a": 1} {"b": 2}',
        '{"a": 1}\n```json\n42\n```',
        '{"a": 1}\n```json\n"text"\n```',
        'Rows:\n```\n[{"name": "Alice"}]\n```\n```json\n[{"name": "Bob"}]\n```',
        'Rows: [{"name": "Alice"}]\n```json\n[{"name": "Bob"}]\n```',
        'Rows: [{"name": "Alice"}], null, [{"name": "Bob"}]',
        'Rows: [{"name": "Alice"}], "and", [{"name": "Bob"}]',
        'Rows: [{"name": "Alice"}] and [{"name": "Bob"}]',
        'Rows: [{"name": "Alice"}], NaN, [{"name": "Bob"}]',
        'Not {"done": true}, since the file is unread. {"thought": "read", "tool_calls": []}',
        'true {"done": true, "answer": "finished"}',
        'Rows: [{"name": "Alice",\n```json\n{"name": "Bob"}\n```',
        'Example only:\n```text\n{"done": true, "answer": "example"}\n```',
        'Example only:\n```python\n{"tool_calls": [{"tool": "workspace.write"}]}\n```',
        'Example: {"done": true, "answer": "example"}\n```',
        '{"done": true, "answer": "A"}\n"Use B instead"\nDone.',
        '{"a": 1}\ntrue\nThat is all.',
        '{"a": 1}\n42 rows were skipped.',
        '```json\n{"a": 1}\n```\n"Use B instead" Done.',
        '{"done": true, "answer": "A"}\n"Use B instead". Done.',
        '{"done": true, "answer": "A"}\n"Use B instead\nDone.',
        '{"a": 1}\ntrue. That is all.',
        'Scores: [1, 2,\n```json\n[3, 4]\n```',
        'Flags: [true, false,\n```json\n[true]\n```',
        '{"done": true, "answer": "A"}\nCorrection:\n"B"',
        '{"done": true, "answer": "A"}\nCorrection:\n"B',
        '{"a": 1}\nUse this instead: 42',
        'Scores: [1e3, 2e3,\n```json\n[3, 4]\n```',
        'Scores: [-1.5E+2,\n```json\n[3]\n```',
        '{"a": 1}\nDone.\n```',
        'Scores: [1\n```json\n[2, 3]\n```',
        'Flags: [true\n```json\n[false]\n```',
        '{"price": 10}\nCorrect price: 20 USD.',
        '{"a": 1}\nUse this instead: 42, it is newer.',
    ],
    ids=[
        'array-closed-early',
        'two-values',
        'value-then-prose-with-value',
        'value-then-number',
        'value-then-true',
        'fenced-array-closed-early',
        'two-fenced-blocks',
        'prose-then-two-arrays',
        'prose-then-two-objects',
        'bare-value-then-fenced-number',
        'bare-value-then-fenced-string',
        'unlabelled-fence-then-json-fence',
        'bare-value-then-json-fence',
        'null-between-values',
        'string-between-values',
        'words-between-values',
        'nan-between-values',
        'example-then-reply',
        'scalar-before-value',
        'unfinished-array-before-json-fence',
        'example-in-a-text-fence',
        'example-in-a-python-fence',
        'closing-fence-with-no-opener',
        'value-then-string-then-prose',
        'value-then-true-then-prose',
        'value-then-number-then-prose',
        'fenced-value-then-string-then-prose',
        'value-then-string-then-punctuation',
        'value-then-unfinished-string',
        'value-then-true-then-punctuation',
        'unfinished-number-array-before-json-fence',
        'unfinished-literal-array-before-json-fence',
        'value-then-label-then-string',
        'value-then-label-then-unfinished-string',
        'value-then-label-and-number-on-one-line',
        'unfinished-exponent-array-before-json-fence',
        'unfinished-signed-exponent-array-before-json-fence',
        'bare-value-remark-then-unopened-fence',
        'unfinished-number-array-without-a-comma-before-json-fence',
        'unfinished-literal-array-without-a-comma-before-json-fence',
        'value-then-label-then-number-and-words',
        'value-then-label-then-number-comma-and-words',
    ],
)
def test_parse_json_never_keeps_part_of_a_broken_reply(raw):
    """A value followed by more JSON is broken, not a reply plus a remark.

    Keeping the first value would drop the rest without a word (Bob's row, the second
    plan). The parse must fail, so ChatBase.chat asks for a repair.
    """
    with pytest.raises(ValueError):
        util.parseJson(raw)


@pytest.mark.parametrize(
    'raw',
    [
        'Here are the rows: [{"name": "Alice"}, {"name": "Bob"}',
        'Here is the user: {"user": {"name": "Bob"}',
        'Compare [A, B] first. {"done": true, "answer": "A"}',
    ],
    ids=['array-cut-off', 'object-cut-off', 'unreadable-bracket-before'],
)
def test_parse_json_never_takes_an_inner_object_for_the_reply(raw):
    """A value cut off part way ends with complete inner objects; none of them is the reply.

    Once a start does not decode, everything after it may be inside that value, so the
    search stops there. A reply with an unreadable bracket in its prose is repaired too:
    that costs a round trip, while a wrong answer would cost the task.
    """
    with pytest.raises(ValueError):
        util.parseJson(raw)


def test_parse_json_still_rejects_prose_with_no_json():
    with pytest.raises(ValueError):
        util.parseJson('I will read the file first, then decide.')


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
