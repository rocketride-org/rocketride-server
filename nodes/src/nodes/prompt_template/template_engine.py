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
Lightweight template engine with Jinja2-style syntax, implemented using only
the Python standard library.

Supported features:
  - Variable substitution:  {{variable}}
  - Built-in helpers:       {{now}}, {{uuid}}, {{random}}
  - Conditionals:           {% if var %}...{% elif var2 %}...{% else %}...{% endif %}
  - Loops:                  {% for item in list %}...{% endfor %}
  - Escape sequences:       \\{{ and \\}} for literal braces
"""

import re
import uuid as _uuid
from datetime import datetime, timezone
from random import random as _random


# Sentinel used to distinguish "key missing" from "key is None"
_MISSING = object()

# ---------------------------------------------------------------------------
# Regex patterns
# ---------------------------------------------------------------------------
_ESCAPE_OPEN = r'\\\{\{'
_ESCAPE_CLOSE = r'\\\}\}'
_PLACEHOLDER_OPEN = '\x00LBRACE\x00'
_PLACEHOLDER_CLOSE = '\x00RBRACE\x00'


# ---------------------------------------------------------------------------
# Built-in helpers
# ---------------------------------------------------------------------------
_BUILTINS = {
    'now': lambda: datetime.now(timezone.utc).isoformat(),
    'uuid': lambda: str(_uuid.uuid4()),
    'random': lambda: str(_random()),
}


# ---------------------------------------------------------------------------
# Context value resolution
# ---------------------------------------------------------------------------
def _resolve(name: str, context: dict):
    """Resolve a dotted name against *context*, falling back to built-ins.

    Resolution order: context takes priority over built-in helpers.
    """
    name = name.strip()

    # 1. Try context first — user-supplied values always win
    parts = name.split('.')
    value = context
    for part in parts:
        if isinstance(value, dict):
            value = value.get(part, _MISSING)
        else:
            value = getattr(value, part, _MISSING)
        if value is _MISSING:
            break

    if value is not _MISSING:
        return value

    # 2. Fall back to built-in helpers only when context lookup failed
    if name in _BUILTINS:
        return _BUILTINS[name]()

    return ''


# ---------------------------------------------------------------------------
# Block-level processing (if / for)
# ---------------------------------------------------------------------------


def _find_matching_end(tokens: list[tuple[str, str]], start: int, open_tag: str, close_tag: str) -> int:
    """Return the index of the matching close_tag, handling nesting."""
    depth = 1
    i = start
    while i < len(tokens):
        kind, text = tokens[i]
        if kind == 'block':
            tag = text.split()[0] if text.strip() else ''
            if tag == open_tag:
                depth += 1
            elif tag == close_tag:
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    return -1


def _tokenize(template: str) -> list[tuple[str, str]]:
    """Split template into a list of (kind, content) tokens.

    Kinds: "text", "var", "block".
    """
    tokens: list[tuple[str, str]] = []
    pos = 0
    combined = re.compile(r'(\{\{.+?\}\}|\{%[-\s]*.*?[-\s]*%\})', re.DOTALL)
    for m in combined.finditer(template):
        if m.start() > pos:
            tokens.append(('text', template[pos : m.start()]))
        raw = m.group(0)
        if raw.startswith('{{'):
            tokens.append(('var', raw[2:-2]))
        else:
            tokens.append(('block', raw[2:-2].strip()))
        pos = m.end()
    if pos < len(template):
        tokens.append(('text', template[pos:]))
    return tokens


def _eval_tokens(tokens: list[tuple[str, str]], context: dict) -> str:
    """Walk a token list and recursively evaluate blocks."""
    parts: list[str] = []
    i = 0
    while i < len(tokens):
        kind, content = tokens[i]

        if kind == 'text':
            parts.append(content)
            i += 1

        elif kind == 'var':
            parts.append(str(_resolve(content, context)))
            i += 1

        elif kind == 'block':
            tag_parts = content.split(None, 1)
            tag = tag_parts[0] if tag_parts else ''

            if tag == 'if':
                i = _handle_if(tokens, i, context, parts)
            elif tag == 'for':
                i = _handle_for(tokens, i, context, parts)
            else:
                parts.append('{%' + content + '%}')
                i += 1
        else:
            i += 1

    return ''.join(parts)


def _at_top_level(tokens, start, pos):
    """Check if *pos* is at the top nesting level between *start* and *pos*."""
    depth_if = 0
    depth_for = 0
    for i in range(start, pos):
        kind, text = tokens[i]
        if kind == 'block':
            tag = text.split()[0] if text.strip() else ''
            if tag == 'if':
                depth_if += 1
            elif tag == 'endif':
                depth_if -= 1
            elif tag == 'for':
                depth_for += 1
            elif tag == 'endfor':
                depth_for -= 1
    return depth_if == 0 and depth_for == 0


def _handle_if(tokens, start, context, parts):
    """Process an {% if %}...{% elif %}...{% else %}...{% endif %} block."""
    end = _find_matching_end(tokens, start + 1, 'if', 'endif')
    if end == -1:
        parts.append('{%' + tokens[start][1] + '%}')
        return start + 1

    branches: list[tuple[str | None, list[tuple[str, str]]]] = []
    tag_content = tokens[start][1]
    cond_text = tag_content.split(None, 1)[1] if len(tag_content.split(None, 1)) > 1 else ''
    body_tokens: list[tuple[str, str]] = []
    i = start + 1
    while i < end:
        kind, text = tokens[i]
        if kind == 'block':
            tag = text.split()[0] if text.strip() else ''
            if tag in ('elif', 'else') and _at_top_level(tokens, start + 1, i):
                branches.append((cond_text, body_tokens))
                body_tokens = []
                if tag == 'elif':
                    cond_text = text.split(None, 1)[1] if len(text.split(None, 1)) > 1 else ''
                else:
                    cond_text = None  # else branch
                i += 1
                continue
        body_tokens.append(tokens[i])
        i += 1
    branches.append((cond_text, body_tokens))

    for cond, body in branches:
        if cond is None or _truthy(_resolve(cond, context)):
            parts.append(_eval_tokens(body, context))
            break

    return end + 1


def _handle_for(tokens, start, context, parts):
    """Process a {% for item in list %}...{% endfor %} block."""
    end = _find_matching_end(tokens, start + 1, 'for', 'endfor')
    if end == -1:
        parts.append('{%' + tokens[start][1] + '%}')
        return start + 1

    content = tokens[start][1]
    m = re.match(r'for\s+(\w+)\s+in\s+(.+)', content)
    if not m:
        parts.append('{%' + content + '%}')
        return end + 1

    loop_var = m.group(1)
    iterable_name = m.group(2).strip()
    iterable = _resolve(iterable_name, context)

    if not hasattr(iterable, '__iter__') or isinstance(iterable, str):
        return end + 1

    body_tokens = tokens[start + 1 : end]
    for item in iterable:
        child_context = {**context, loop_var: item}
        parts.append(_eval_tokens(body_tokens, child_context))

    return end + 1


def _truthy(value) -> bool:
    """Determine whether a template value is truthy."""
    if value is _MISSING or value is None:
        return False
    if isinstance(value, str):
        return value != ''
    return bool(value)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def render(template: str, context: dict | None = None) -> str:
    """Render *template* with the given *context* dictionary.

    Parameters
    ----------
    template:
        The template string containing ``{{var}}``, ``{% if %}``, ``{% for %}``
        constructs.
    context:
        A dictionary of variables available for substitution.

    Returns
    -------
    The rendered string.
    """
    if context is None:
        context = {}

    # 1. Protect escaped braces
    text = re.sub(_ESCAPE_OPEN, _PLACEHOLDER_OPEN, template)
    text = re.sub(_ESCAPE_CLOSE, _PLACEHOLDER_CLOSE, text)

    # 2. Tokenize and evaluate
    tokens = _tokenize(text)
    result = _eval_tokens(tokens, context)

    # 3. Restore escaped braces
    result = result.replace(_PLACEHOLDER_OPEN, '{{')
    result = result.replace(_PLACEHOLDER_CLOSE, '}}')

    return result
