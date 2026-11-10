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
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
The restricted template engine public-page snapshots are rendered with.

Variables, sections and dotted access only; every value is escaped, the unsafe
Mustache features do not exist, and template syntax inside data is inert.
"""

from __future__ import annotations

import time

import pytest

from ai.modules.shell.template import MAX_SECTION_DEPTH, TemplateError, render

from .hostile_fixtures import HOSTILE_DESCRIPTION, HOSTILE_NAME

CTX = {
    'apps': [
        {'name': 'Brandy', 'url': 'https://brandy.example', 'description': 'Kits.'},
        {'name': 'Echo', 'url': '', 'description': 'Echoes.'},
    ],
    'plan': {'price': '20', 'tier': {'label': 'Pro'}},
    'count': 0,
    'flag': True,
    'empty': [],
}


def test_variables_dotted_access_and_sections():
    tpl = (
        '{{#apps}}<h3>{{name}}</h3>{{#url}}<a href="{{url}}">go</a>{{/url}}{{/apps}}|{{plan.price}}|{{plan.tier.label}}'
    )
    assert render(tpl, CTX) == '<h3>Brandy</h3><a href="https://brandy.example">go</a><h3>Echo</h3>|20|Pro'


def test_sections_conditional_on_presence():
    assert render('{{#flag}}yes{{/flag}}{{#empty}}no{{/empty}}{{#count}}no{{/count}}', CTX) == 'yes'
    assert render('{{#plan}}{{price}}{{/plan}}', CTX) == '20'


def test_outer_context_visible_inside_sections():
    assert render('{{#apps}}{{plan.price}}{{/apps}}', CTX) == '2020'


def test_a_list_item_that_is_not_a_mapping_falls_through_to_the_outer_context():
    issues = []
    out = render('{{#a}}[{{b}}{{.}}]{{/a}}', {'a': ['x', 'y'], 'b': 'B'}, on_issue=issues.append)
    assert out == '[B][B]'
    assert len(issues) == 1 and '{{.}}' in issues[0]


def test_unknown_fields_render_empty_and_log():
    issues = []
    out = render('a{{nope}}b{{plan.nope}}c{{#ghost}}x{{/ghost}}d{{apps}}e', CTX, on_issue=issues.append)
    assert out == 'abcde'
    assert len(issues) == 4


def test_whitespace_inside_a_tag_is_ignored():
    assert render('{{ plan.price }}{{# flag }}!{{/ flag }}', CTX) == '20!'


@pytest.mark.parametrize(
    'tpl',
    ['{{{name}}}', '{{&name}}', '{{>partial}}', '{{!comment}}', '{{=<% %>=}}', '{{^flag}}', '{{ bad name }}', '{{}}'],
)
def test_unsafe_mustache_features_do_not_exist(tpl):
    issues = []
    assert render(tpl, {'name': '<b>raw</b>', 'flag': True}, on_issue=issues.append) == ''
    assert issues


def test_unbalanced_sections_never_error():
    issues = []
    assert render('{{#flag}}a{{/other}}b', CTX, on_issue=issues.append) == 'ab'
    assert len(issues) == 2


@pytest.mark.parametrize('payload', [HOSTILE_NAME, HOSTILE_DESCRIPTION, '"><svg onload=alert(1)>', "' onmouseover='x"])
def test_hostile_values_are_escaped_unconditionally(payload):
    out = render('<p title="{{v}}">{{v}}</p>', {'v': payload})
    assert '<script' not in out and '<img' not in out and '<svg' not in out
    assert out.count('"') == 2  # only the template's own attribute quotes
    assert "'" not in out


@pytest.mark.parametrize('payload', [HOSTILE_NAME, HOSTILE_DESCRIPTION])
def test_hostile_values_inside_sections_are_escaped(payload):
    out = render('{{#apps}}<h3>{{name}}</h3>{{/apps}}', {'apps': [{'name': payload}]})
    assert '<script' not in out and '<img' not in out
    assert out.startswith('<h3>') and out.endswith('</h3>') and out.count('<') == 2


def test_template_syntax_inside_data_is_inert():
    # A value carrying Mustache syntax is substituted once, never re-parsed.
    out = render(
        '{{#apps}}{{description}}{{/apps}}', {'apps': [{'description': '{{#apps}}{{secret}}{{/apps}}'}], 'secret': 'S'}
    )
    assert out == '{{#apps}}{{secret}}{{/apps}}'


def test_non_scalar_values_render_empty():
    assert render('{{plan}}', CTX, on_issue=lambda m: None) == ''


def test_scalars_render_as_text():
    assert render('{{a}}|{{b}}|{{c}}|{{d}}', {'a': 3, 'b': 2.5, 'c': False, 'd': None}) == '3|2.5|false|'


def test_custom_escaper_is_used_for_every_value():
    assert render('{{a}}-{{b}}', {'a': 'x', 'b': 3}, escape=lambda v: v.upper() + '!') == 'X!-3!'


def test_a_stray_open_tag_keeps_the_following_markup():
    tpl = '<pre>a {{ b</pre><p>lots</p><img src="{{assets}}/x">'
    out = render(tpl, {'assets': '/apps/a/v1'})
    assert out == '<pre>a {{ b</pre><p>lots</p><img src="/apps/a/v1/x">'


@pytest.mark.parametrize('tpl', ['{{assets\n}}', '{{' + 'a' * 200 + '}}'])
def test_a_tag_is_one_short_line(tpl):
    assert render(tpl, {'assets': 'A', 'a' * 200: 'B'}) == tpl


def test_a_run_of_open_braces_renders_in_linear_time():
    tpl = '{{' * 100_000  # 200 KB
    start = time.perf_counter()
    assert render(tpl, {}) == tpl
    assert time.perf_counter() - start < 1.0


def test_engine_names_resolve_from_the_root_context_only():
    ctx = {'assets': '/apps/a/v1', 'apps': [{'assets': 'javascript:alert(1)', 'name': 'Brandy'}]}
    out = render('{{#apps}}<a href="{{assets}}/x">{{name}}</a>{{#assets}}!{{/assets}}{{/apps}}', ctx)
    assert out == '<a href="/apps/a/v1/x">Brandy</a>!'


def test_sections_nest_up_to_the_cap():
    tpl = '{{#a}}' * MAX_SECTION_DEPTH + 'deep' + '{{/a}}' * MAX_SECTION_DEPTH
    assert render(tpl, {'a': True}) == 'deep'


@pytest.mark.parametrize('depth', [MAX_SECTION_DEPTH + 1, 5000])
def test_deeper_nesting_is_a_template_error(depth):
    with pytest.raises(TemplateError, match='nest deeper than'):
        render('{{#a}}' * depth + 'x', {'a': True})
