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
The restricted, logic-less template engine public-page snapshots are rendered with.

It supports exactly three things, Mustache-style:

    {{name}} / {{a.b}}         a variable (dotted access walks mapping keys only)
    {{#name}} ... {{/name}}    a section: iterates a list, enters a mapping,
                               renders once for any other truthy value, and
                               renders nothing for an absent, empty or false one

There is no ``{{.}}`` (the current list item): it is an unsupported tag. A
list item that is not a mapping adds no names, so a tag inside its section
resolves against the enclosing contexts, as in Mustache: ``{{b}}`` inside
``{{#a}}`` over ``['x']`` renders the root ``b``.

A tag is one short line (at most 128 characters between the braces, none of
them a brace): a stray ``{{`` is plain text and never swallows the markup that
follows, and parsing stays linear in the template's size.

Every substituted value is escaped, unconditionally, by the caller's escaper
(HTML by default). The unsafe Mustache features (raw ``{{{x}}}`` and
``{{&x}}``, partials, lambdas, inverted sections, delimiter changes) do not
exist: a tag the grammar does not know renders as nothing and is logged.
Values are substituted in one pass and never re-parsed, so template syntax
inside data (a store description containing ``{{...}}``) is inert. The names
the server provides on every page (``ROOT_NAMES``) resolve from the root
context only, so no record bound inside a section can shadow them.

A tag naming an unknown field renders empty at that spot and is logged: a
public page never becomes an error page because of its template. Sections
nested deeper than ``MAX_SECTION_DEPTH`` are the one template error
(``TemplateError``).
"""

import html
import re
from typing import Any, Callable, List, Mapping, NamedTuple, Optional, Union

from rocketlib import debug

_TAG = re.compile(r'\{\{(\{?)([^{}\n]{0,128})(\}?)\}\}')
_NAME = re.compile(r'^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$')
_MISSING = object()

# Names the server sets at the root of every render.
ROOT_NAMES = frozenset({'assets'})

# How deeply sections may nest (rendering recurses once per level).
MAX_SECTION_DEPTH = 16


class TemplateError(Exception):
    """A template the engine refuses to render."""


class Text(NamedTuple):
    """Template text outside any tag, copied as is."""

    text: str


class Var(NamedTuple):
    """A ``{{name}}`` tag: the escaped scalar ``name`` resolves to."""

    name: str


class Section(NamedTuple):
    """A ``{{#name}} ... {{/name}}`` section and the nodes inside it."""

    name: str
    children: List['Node']


Node = Union[Text, Var, Section]


def _log(issue: str) -> None:
    debug(f'[public_pages] template: {issue}')


def html_escape(value: str) -> str:
    """The default escaper.

    Safe in HTML text and in quoted attributes that are not URLs. It is not
    safe in a URL attribute (``href``, ``src``, ...), an event handler,
    ``style``, ``<script>`` or an unquoted attribute: only server-derived
    values (``assets``) go there.

    Args:
        value: The text to substitute.

    Returns:
        ``value`` with ``&``, ``<``, ``>``, ``"`` and ``'`` escaped.
    """
    return html.escape(value, quote=True)


def render(
    template: str,
    context: Mapping[str, Any],
    escape: Callable[[str], str] = html_escape,
    on_issue: Callable[[str], None] = _log,
) -> str:
    """Render ``template`` against ``context``, escaping every substituted value with ``escape``.

    Args:
        template: The template text (a snapshot, decoded).
        context: The root context: the names the server provides
            (``ROOT_NAMES``) and the page's bound data.
        escape: Applied to every substituted value (default: ``html_escape``).
        on_issue: Called with a description of each dropped tag and each
            unknown or non-scalar field (default: a debug log line).

    Returns:
        The rendered text.

    Raises:
        TemplateError: sections nest deeper than ``MAX_SECTION_DEPTH``.
    """
    renderer = _Renderer(escape, on_issue)
    renderer.render_nodes(parse(template, on_issue), [context])
    return ''.join(renderer.out)


def parse(template: str, on_issue: Callable[[str], None] = _log) -> List[Node]:
    """Parse a template into nodes; unsupported tags are dropped and reported.

    Args:
        template: The template text.
        on_issue: Called with a description of each tag dropped or section
            left open (default: a debug log line).

    Returns:
        The top-level nodes (``Text``, ``Var`` and ``Section``).

    Raises:
        TemplateError: sections nest deeper than ``MAX_SECTION_DEPTH``.
    """
    # The innermost open section last; the root is a nameless section that never closes.
    root = Section('', [])
    stack: List[Section] = [root]
    pos = 0
    for match in _TAG.finditer(template):
        if match.start() > pos:
            stack[-1].children.append(Text(template[pos : match.start()]))
        pos = match.end()
        raw = match.group(2).strip()
        if match.group(1) or match.group(3):
            on_issue(f'unsupported raw tag {{{{{{{raw}}}}}}} dropped')
            continue
        sigil = ''
        name = raw
        if raw[:1] in ('#', '/'):
            sigil = raw[:1]
            name = raw[1:].strip()
        if not _NAME.match(name):
            on_issue(f'unsupported tag {{{{{raw}}}}} dropped')
            continue
        if sigil == '#':
            if len(stack) > MAX_SECTION_DEPTH:
                raise TemplateError(f'sections nest deeper than {MAX_SECTION_DEPTH} levels')
            section = Section(name, [])
            stack[-1].children.append(section)
            stack.append(section)
        elif sigil == '/':
            if len(stack) > 1 and stack[-1].name == name:
                stack.pop()
            else:
                on_issue(f'unmatched close tag {{{{/{name}}}}} dropped')
        else:
            stack[-1].children.append(Var(name))
    if pos < len(template):
        stack[-1].children.append(Text(template[pos:]))
    for section in stack[1:]:
        on_issue(f'section {{{{#{section.name}}}}} never closed (closed at end of template)')
    return root.children


class _Renderer:
    """One render: appends to ``out``, escaping every substituted value with ``escape``.

    Every method takes ``contexts``, the lookup stack, innermost last.
    """

    def __init__(self, escape: Callable[[str], str], on_issue: Callable[[str], None]) -> None:
        self.escape = escape
        self.on_issue = on_issue
        self.out: List[str] = []

    def render_nodes(self, nodes: List[Node], contexts: List[Any]) -> None:
        """Append the rendering of ``nodes``."""
        for node in nodes:
            if isinstance(node, Text):
                self.out.append(node.text)
            elif isinstance(node, Var):
                self.render_var(node, contexts)
            else:
                self.render_section(node, contexts)

    def render_var(self, var: Var, contexts: List[Any]) -> None:
        """Append the escaped scalar the tag names; an unknown or non-scalar field renders empty (reported)."""
        # _MISSING is not a scalar either.
        text = _scalar(_lookup(contexts, var.name))
        if text is None:
            self.on_issue(f'{{{{{var.name}}}}} names an unknown or non-scalar field (rendered empty)')
            return
        self.out.append(self.escape(text))

    def render_section(self, section: Section, contexts: List[Any]) -> None:
        """Append the children once per list item, once inside a non-empty mapping, or once for any other truthy value.

        An unknown field renders nothing (reported). Each list item is pushed
        as a context; one that is not a mapping adds no names (see the module
        docstring).
        """
        value = _lookup(contexts, section.name)
        if value is _MISSING:
            self.on_issue(f'section {{{{#{section.name}}}}} names an unknown field (rendered empty)')
            return
        if isinstance(value, list):
            for item in value:
                self.render_nodes(section.children, contexts + [item])
        elif isinstance(value, Mapping) and value:
            self.render_nodes(section.children, contexts + [value])
        elif value:
            self.render_nodes(section.children, contexts)


def _lookup(contexts: List[Any], name: str) -> Any:
    """The value the dotted ``name`` resolves to, innermost context first, else ``_MISSING``."""
    head, *rest = name.split('.')
    # A server-provided name resolves from the root context only, so no
    # record bound inside a section can shadow it.
    scopes = contexts
    if head in ROOT_NAMES:
        scopes = contexts[:1]
    for context in reversed(scopes):
        if isinstance(context, Mapping) and head in context:
            value = context[head]
            for part in rest:
                if not isinstance(value, Mapping) or part not in value:
                    return _MISSING
                value = value[part]
            return value
    return _MISSING


def _scalar(value: Any) -> Optional[str]:
    """``value`` as text when it is a scalar (None renders empty), else None."""
    if value is None:
        return ''
    if isinstance(value, bool):
        if value:
            return 'true'
        return 'false'
    if isinstance(value, (str, int, float)):
        return str(value)
    return None
