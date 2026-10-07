# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How ``Question.getPrompt`` lays out instruction blocks.

Every line of an instruction block used to be stripped and re-indented to one
depth, so a code example in a node's instructions reached the model flat. Python
loses its meaning that way, and the model copies the flattened shape. Only the
indentation every line of the block shares is now removed (textwrap.dedent), and each
line keeps the rest.
"""

from rocketride.schema.question import Question

CODE = """When you add a React component, follow this shape:
export function Card({ title }: { title: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
    </div>
  );
}"""


def _instruction_lines(text: str) -> list:
    q = Question()
    q.addInstruction('Example', text)
    prompt = q.getPrompt()
    block = prompt.split('**Example**:', 1)[1].split('\r\n\r\n', 1)[0]
    return [line for line in block.split('\r\n') if line]


def test_code_keeps_its_nesting():
    lines = _instruction_lines(CODE)

    assert lines[0] == '        When you add a React component, follow this shape:'
    assert '          return (' in lines
    assert '            <div className="card">' in lines
    assert '              <h2>{title}</h2>' in lines


def test_source_indentation_shared_by_every_line_is_removed():
    """An indented triple-quoted block loses its source margin; the continuation keeps its two extra spaces."""
    text = """\
        - First rule.
        - Second rule,
          continued."""

    assert _instruction_lines(text) == ['        - First rule.', '        - Second rule,', '          continued.']


def test_a_function_body_keeps_its_indentation():
    """A runtime string whose first line is the code itself (e.g. from node config) keeps its body indented."""
    assert _instruction_lines('def answer():\n    return 42') == ['        def answer():', '            return 42']


def test_crlf_and_blank_lines_render_as_before():
    assert _instruction_lines('- one\r\n\r\n- two\r\n') == ['        - one', '        - two']


def test_lone_cr_endings_keep_a_shared_margin_shared():
    """Old Mac endings (a lone \\r): every line shares the margin, so every line loses it."""
    assert _instruction_lines('    - one\r    - two') == ['        - one', '        - two']
