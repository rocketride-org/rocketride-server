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

"""
Unit tests for the custom prompt_template engine.

These tests exercise ``nodes/src/nodes/prompt_template/template_engine.py`` in
isolation — no server, no dependencies beyond the Python standard library and
pytest. The engine is loaded directly via ``importlib`` so that importing the
surrounding ``nodes`` package (which pulls in ``depends``) is avoided.

Coverage targets:
    - variable substitution (flat + dotted paths)
    - missing variables / graceful fallback
    - built-in helpers (``now``, ``uuid``, ``random``)
    - context overriding built-ins (regression guard)
    - conditionals (``if`` / ``elif`` / ``else`` / nested)
    - empty and malformed ``{% if %}`` conditions
    - loops (flat + nested)
    - unclosed / malformed block tags
    - escape sequences for literal braces
    - large inputs / deeply nested blocks (ReDoS + recursion safety)
    - HTML pass-through (no implicit escaping)
"""

import importlib.util
import sys
import uuid as _uuid
from pathlib import Path


# ---------------------------------------------------------------------------
# Load template_engine.py directly without importing the ``nodes`` package.
#
# ``nodes/__init__.py`` pulls in the ``depends`` module which is only available
# inside the built server environment. Loading the engine file directly keeps
# these tests pure and runnable anywhere Python is available.
# ---------------------------------------------------------------------------
_ENGINE_PATH = Path(__file__).resolve().parent.parent / 'src' / 'nodes' / 'prompt_template' / 'template_engine.py'

_spec = importlib.util.spec_from_file_location('prompt_template_engine', _ENGINE_PATH)
assert _spec is not None and _spec.loader is not None, 'failed to locate template_engine.py'
template_engine = importlib.util.module_from_spec(_spec)
sys.modules['prompt_template_engine'] = template_engine
_spec.loader.exec_module(template_engine)

render = template_engine.render


# ===========================================================================
# 1. Simple variable substitution
# ===========================================================================
class TestVariableSubstitution:
    def test_flat_variable(self):
        assert render('Hello {{name}}', {'name': 'world'}) == 'Hello world'

    def test_multiple_variables(self):
        result = render('{{greeting}}, {{name}}!', {'greeting': 'Hi', 'name': 'Ada'})
        assert result == 'Hi, Ada!'

    def test_whitespace_inside_braces_is_stripped(self):
        assert render('Hello {{ name }}', {'name': 'world'}) == 'Hello world'

    def test_dotted_path(self):
        ctx = {'user': {'email': 'ada@example.com'}}
        assert render('{{user.email}}', ctx) == 'ada@example.com'

    def test_deep_dotted_path(self):
        ctx = {'a': {'b': {'c': {'d': 'leaf'}}}}
        assert render('{{a.b.c.d}}', ctx) == 'leaf'

    def test_dotted_path_with_attribute_object(self):
        class Obj:
            pass

        o = Obj()
        o.name = 'attribute-value'
        assert render('{{obj.name}}', {'obj': o}) == 'attribute-value'

    def test_non_string_value_is_stringified(self):
        assert render('count={{n}}', {'n': 42}) == 'count=42'

    def test_empty_template(self):
        assert render('', {'name': 'world'}) == ''

    def test_none_context(self):
        # Should not crash when context is None.
        assert render('hello', None) == 'hello'

    def test_template_without_placeholders_passthrough(self):
        assert render('no placeholders here', {}) == 'no placeholders here'


# ===========================================================================
# 2. Missing variables / graceful handling
# ===========================================================================
class TestMissingVariables:
    def test_missing_flat_variable_renders_empty(self):
        assert render('Hello {{name}}', {}) == 'Hello '

    def test_missing_dotted_segment_renders_empty(self):
        assert render('{{user.email}}', {'user': {}}) == ''

    def test_missing_dotted_root_renders_empty(self):
        assert render('{{user.email}}', {}) == ''

    def test_missing_variable_does_not_raise(self):
        # Graceful handling is a documented contract.
        render('{{a}} {{b}} {{c.d}}', {'a': 'x'})  # must not raise


# ===========================================================================
# 3. Built-in helpers
# ===========================================================================
class TestBuiltins:
    def test_now_is_iso_format_utc(self):
        out = render('{{now}}', {})
        # ISO8601 with timezone — has a 'T' separator and a '+00:00' suffix.
        assert 'T' in out
        assert out.endswith('+00:00')

    def test_uuid_is_valid_uuid4(self):
        out = render('{{uuid}}', {})
        parsed = _uuid.UUID(out)
        assert parsed.version == 4

    def test_random_is_float_between_zero_and_one(self):
        out = render('{{random}}', {})
        value = float(out)
        assert 0.0 <= value < 1.0

    def test_builtins_work_inside_larger_template(self):
        out = render('id={{uuid}}', {})
        assert out.startswith('id=')
        # The suffix must still be a valid UUID4
        _uuid.UUID(out[len('id=') :])


# ===========================================================================
# 4. Context overrides built-ins (regression test for the recent fix)
# ===========================================================================
class TestContextOverridesBuiltins:
    def test_context_value_wins_over_now(self):
        assert render('{{now}}', {'now': 'FIXED'}) == 'FIXED'

    def test_context_value_wins_over_uuid(self):
        assert render('{{uuid}}', {'uuid': 'static-id'}) == 'static-id'

    def test_context_value_wins_over_random(self):
        assert render('{{random}}', {'random': '0.5'}) == '0.5'

    def test_builtin_still_used_when_not_in_context(self):
        # Sanity: when `now` is absent from context, the builtin fires.
        out = render('{{now}}', {'other': 'value'})
        assert 'T' in out  # builtin ran


# ===========================================================================
# 5. Conditionals
# ===========================================================================
class TestConditionals:
    def test_if_true_branch(self):
        assert render('{% if flag %}yes{% endif %}', {'flag': True}) == 'yes'

    def test_if_false_branch(self):
        assert render('{% if flag %}yes{% endif %}', {'flag': False}) == ''

    def test_if_else_true(self):
        tpl = '{% if flag %}yes{% else %}no{% endif %}'
        assert render(tpl, {'flag': True}) == 'yes'

    def test_if_else_false(self):
        tpl = '{% if flag %}yes{% else %}no{% endif %}'
        assert render(tpl, {'flag': False}) == 'no'

    def test_elif_matches_second(self):
        tpl = '{% if a %}A{% elif b %}B{% else %}C{% endif %}'
        assert render(tpl, {'a': False, 'b': True}) == 'B'

    def test_elif_falls_through_to_else(self):
        tpl = '{% if a %}A{% elif b %}B{% else %}C{% endif %}'
        assert render(tpl, {'a': False, 'b': False}) == 'C'

    def test_empty_string_is_falsy(self):
        assert render('{% if s %}yes{% endif %}', {'s': ''}) == ''

    def test_none_is_falsy(self):
        assert render('{% if s %}yes{% endif %}', {'s': None}) == ''

    def test_missing_variable_is_falsy(self):
        # Missing vars resolve to '' which is falsy, so the branch is skipped.
        assert render('{% if absent %}yes{% endif %}', {}) == ''

    def test_empty_if_condition_is_falsy(self):
        # `{% if %}` has no condition name -> resolves to empty string -> falsy.
        # Must not raise; must render the else branch.
        tpl = '{% if %}T{% else %}F{% endif %}'
        assert render(tpl, {}) == 'F'

    def test_nested_if_inner_branch(self):
        tpl = '{% if a %}A-{% if b %}B{% else %}NB{% endif %}{% endif %}'
        assert render(tpl, {'a': True, 'b': True}) == 'A-B'
        assert render(tpl, {'a': True, 'b': False}) == 'A-NB'
        assert render(tpl, {'a': False, 'b': True}) == ''

    def test_dotted_condition(self):
        tpl = '{% if user.active %}on{% else %}off{% endif %}'
        assert render(tpl, {'user': {'active': True}}) == 'on'
        assert render(tpl, {'user': {'active': False}}) == 'off'


# ===========================================================================
# 6. Loops
# ===========================================================================
class TestLoops:
    def test_basic_for_loop(self):
        tpl = '{% for item in items %}{{item}},{% endfor %}'
        assert render(tpl, {'items': ['a', 'b', 'c']}) == 'a,b,c,'

    def test_for_loop_empty_iterable(self):
        tpl = '[{% for item in items %}{{item}}{% endfor %}]'
        assert render(tpl, {'items': []}) == '[]'

    def test_for_loop_over_dicts_with_dotted_access(self):
        tpl = '{% for u in users %}{{u.name}}:{% endfor %}'
        ctx = {'users': [{'name': 'ada'}, {'name': 'bob'}]}
        assert render(tpl, ctx) == 'ada:bob:'

    def test_for_loop_with_missing_iterable_is_noop(self):
        tpl = 'start[{% for item in items %}{{item}}{% endfor %}]end'
        assert render(tpl, {}) == 'start[]end'

    def test_for_loop_over_string_is_noop(self):
        # _handle_for explicitly skips strings so we don't iterate characters.
        tpl = '{% for c in s %}{{c}}{% endfor %}'
        assert render(tpl, {'s': 'hello'}) == ''

    def test_nested_for_loops(self):
        tpl = '{% for row in rows %}{% for cell in row %}{{cell}},{% endfor %}|{% endfor %}'
        ctx = {'rows': [[1, 2], [3, 4]]}
        assert render(tpl, ctx) == '1,2,|3,4,|'

    def test_loop_variable_shadowing(self):
        # Loop var should be visible only inside the loop body.
        tpl = '{% for x in items %}{{x}},{% endfor %}outer:{{x}}'
        assert render(tpl, {'items': ['a', 'b'], 'x': 'OUT'}) == 'a,b,outer:OUT'


# ===========================================================================
# 7. Malformed / unclosed tags
# ===========================================================================
class TestMalformedTags:
    def test_unclosed_if_emits_raw_tag(self):
        # When there's no matching endif, the engine falls back to rendering
        # the raw tag text and continuing — graceful rather than crashing.
        out = render('{% if flag %}body', {'flag': True})
        # The raw tag is preserved; the body is still processed as text.
        assert 'if flag' in out
        assert 'body' in out

    def test_unclosed_for_emits_raw_tag(self):
        out = render('{% for x in items %}body', {'items': [1, 2]})
        assert 'for x in items' in out
        assert 'body' in out

    def test_malformed_for_tag_is_noop(self):
        # `{% for foo %}` has no `in ...` clause — regex match fails, the raw
        # tag is emitted and the body between tags is dropped. The engine
        # must not raise.
        out = render('before{% for foo %}X{% endfor %}after', {})
        assert out.startswith('before')
        assert out.endswith('after')
        assert 'X' not in out  # body is dropped

    def test_unknown_block_tag_is_passed_through(self):
        tpl = 'x{% weird tag %}y'
        out = render(tpl, {})
        assert 'weird tag' in out
        assert out.startswith('x')
        assert out.endswith('y')


# ===========================================================================
# 8. Escape sequences
# ===========================================================================
class TestEscapes:
    def test_escaped_open_brace(self):
        # \{{ should render as literal {{
        assert render(r'\{{name}}', {'name': 'ignored'}) == '{{name}}'

    def test_escaped_close_brace(self):
        # \}} should render as literal }}
        assert render(r'{{name}}\}}', {'name': 'X'}) == 'X}}'

    def test_escaped_pair_does_not_substitute(self):
        assert render(r'\{{x\}}', {'x': 'should-not-appear'}) == '{{x}}'


# ===========================================================================
# 9. HTML pass-through (no implicit escaping)
# ===========================================================================
class TestHtmlPassthrough:
    def test_html_substituted_unchanged(self):
        # The engine does NOT auto-escape — confirming existing behavior so
        # that any future change is a conscious one. Callers are responsible
        # for sanitizing untrusted values.
        tpl = 'Result: {{payload}}'
        ctx = {'payload': '<script>alert(1)</script>'}
        assert render(tpl, ctx) == 'Result: <script>alert(1)</script>'

    def test_html_entity_in_template_is_literal(self):
        assert render('&amp;', {}) == '&amp;'


# ===========================================================================
# 10. Safety: large / deeply-nested input (ReDoS + recursion)
# ===========================================================================
class TestSafety:
    def test_large_literal_input_runs_quickly(self):
        # ~50KB of plain text with no placeholders — tokenizer regex must not
        # blow up (ReDoS guard). Timing check is intentionally loose.
        import time

        template = 'x' * 50_000 + '{{v}}' + 'y' * 50_000
        start = time.perf_counter()
        out = render(template, {'v': 'MID'})
        elapsed = time.perf_counter() - start
        assert 'MID' in out
        assert elapsed < 2.0  # generous upper bound

    def test_many_placeholders(self):
        tpl = ''.join(f'{{{{v{i}}}}}' for i in range(500))
        ctx = {f'v{i}': str(i) for i in range(500)}
        out = render(tpl, ctx)
        assert out == ''.join(str(i) for i in range(500))

    def test_nested_if_blocks_do_not_blow_stack(self):
        depth = 50
        tpl = '{% if flag %}' * depth + 'X' + '{% endif %}' * depth
        out = render(tpl, {'flag': True})
        assert out == 'X'

    def test_nested_for_blocks_do_not_blow_stack(self):
        # 10 nested loops of 1 item each — exercises the recursive
        # _eval_tokens path without exploding combinatorially.
        depth = 10
        header = ''.join(f'{{% for x{i} in items %}}' for i in range(depth))
        footer = '{% endfor %}' * depth
        tpl = header + 'Y' + footer
        out = render(tpl, {'items': [1]})
        assert out == 'Y'


# ===========================================================================
# 11. Public API surface
# ===========================================================================
class TestPublicAPI:
    def test_render_returns_string(self):
        assert isinstance(render('hello', {}), str)

    def test_render_accepts_none_context(self):
        assert render('hello {{x}}', None) == 'hello '

    def test_regression_for_question_substitution(self):
        # Mirrors the real IInstance.closing() usage where `question` is
        # injected into the per-render context alongside collected text.
        tpl = 'Q={{question}} | I={{input}}'
        ctx = {'question': 'what is this?', 'input': 'ctx'}
        assert render(tpl, ctx) == 'Q=what is this? | I=ctx'
