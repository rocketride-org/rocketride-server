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
Serve-time head metadata injection for public pages.

Replaces (never duplicates) the document's title, meta description,
canonical link, robots meta and Open Graph title/description/url, and
inserts JSON-LD blocks. Every value is escaped for its context: page
titles are manifest text entering a platform-origin document, so escaping
is a security boundary.
"""

import html
import json
import re
from typing import Any, Iterable, Mapping

_FLAGS = re.IGNORECASE | re.DOTALL

# One unit of a tag's attribute text: a character outside quotes, or a whole
# quoted value, so a '>' or an 'attr=' inside a value is not tag syntax.
_ATTR_UNIT = r'(?:[^>"\']|"[^"]*"|\'[^\']*\')'


def _tag_with(tag: str, attr: str, value: str) -> re.Pattern:
    """A <tag ...> whose attr equals value (any attribute order/quoting).

    ``attr`` must be a whole attribute name: ``data-name`` is not ``name``.
    """
    return re.compile(
        rf'<{tag}\b(?={_ATTR_UNIT}*?(?<![\w-]){attr}\s*=\s*["\']?{re.escape(value)}["\'\s/>]){_ATTR_UNIT}*>\s*',
        _FLAGS,
    )


_REPLACED = (
    re.compile(r'<title\b[^>]*>.*?</title\s*>\s*', _FLAGS),
    _tag_with('meta', 'name', 'description'),
    _tag_with('meta', 'name', 'robots'),
    _tag_with('link', 'rel', 'canonical'),
    _tag_with('meta', 'property', 'og:title'),
    _tag_with('meta', 'property', 'og:description'),
    _tag_with('meta', 'property', 'og:url'),
)
_HEAD_OPEN = re.compile(r'<head\b[^>]*>', re.IGNORECASE)
_CHARSET = re.compile(r'<meta\b[^>]*?(?:\bcharset\s*=|\bhttp-equiv\s*=\s*["\']?content-type\b)[^>]*>', re.IGNORECASE)
_HEAD_SPAN = re.compile(r'<head\b[^>]*>.*?</head\s*>', _FLAGS)
_BODY_OPEN = re.compile(r'<body\b', re.IGNORECASE)
_HTML_OPEN = re.compile(r'<html\b[^>]*>', re.IGNORECASE)


def _attr(value: str) -> str:
    return html.escape(value, quote=True)


def jsonld_script(obj: Mapping[str, Any]) -> str:
    """One <script type="application/ld+json"> block, safe inside HTML.

    <, > and & (and the JS line separators) are emitted as unicode escapes,
    so no value can close the script element.

    Args:
        obj: The JSON-LD node.

    Returns:
        The ``<script>`` element, ready to put in a document head.
    """
    text = json.dumps(obj, ensure_ascii=False, separators=(',', ':'), sort_keys=True)
    for raw, escaped in (
        ('<', '\\u003c'),
        ('>', '\\u003e'),
        ('&', '\\u0026'),
        ('\u2028', '\\u2028'),
        ('\u2029', '\\u2029'),
    ):
        text = text.replace(raw, escaped)
    return f'<script type="application/ld+json">{text}</script>'


def inject_head(
    document: str,
    *,
    title: str,
    description: str = '',
    canonical: str = '',
    noindex: bool = False,
    jsonld: Iterable[Mapping[str, Any]] = (),
) -> str:
    """Return ``document`` with the page's head metadata in place.

    Existing tags of the same kinds are removed first; the new block goes
    right after the head's charset declaration, which must stay within the
    document's first 1024 bytes, else right after <head> (or after <html>,
    or at the very start). Every value is HTML-escaped.

    Args:
        document: The HTML document (the shell's, or a page snapshot).
        title: The document title; also ``og:title``.
        description: The meta description and ``og:description``; none when empty.
        canonical: The absolute canonical URL and ``og:url``; none when empty.
        noindex: Whether to add ``<meta name="robots" content="noindex">``.
        jsonld: JSON-LD nodes, one ``<script type="application/ld+json">``
            each (``jsonld_script``).

    Returns:
        The document with the new block in its head.
    """
    # Only the head's tags are replaced: an inline SVG <title> in the body,
    # or a '<title>' string in a script, is content. Without a <head>, the
    # region before <body> stands in for it.
    span = _HEAD_SPAN.search(document)
    if span:
        start, end = span.span()
    else:
        start, end = 0, len(document)
        body = _BODY_OPEN.search(document)
        if body:
            end = body.start()
    region = document[start:end]
    for pattern in _REPLACED:
        region = pattern.sub('', region)
    document = document[:start] + region + document[end:]
    parts = [
        f'<title>{html.escape(title, quote=False)}</title>',
        f'<meta property="og:title" content="{_attr(title)}">',
    ]
    if description:
        parts.append(f'<meta name="description" content="{_attr(description)}">')
        parts.append(f'<meta property="og:description" content="{_attr(description)}">')
    if canonical:
        parts.append(f'<link rel="canonical" href="{_attr(canonical)}">')
        parts.append(f'<meta property="og:url" content="{_attr(canonical)}">')
    if noindex:
        parts.append('<meta name="robots" content="noindex">')
    parts.extend(jsonld_script(obj) for obj in jsonld)
    block = ''.join(parts)
    at = _insertion_point(document, start, start + len(region))
    return document[:at] + block + document[at:]


def _insertion_point(document: str, head_start: int, head_end: int) -> int:
    """Where the head block goes: right after the first of these the document has.

    The head's charset declaration (it must stay within the first 1024
    bytes), else ``<head>``, else ``<html>``, else the very start.

    Args:
        document: The HTML document, its old head tags already removed.
        head_start: Where the head region starts.
        head_end: Where the head region ends.

    Returns:
        The offset to insert the block at.
    """
    charset = _CHARSET.search(document, head_start, head_end)
    if charset:
        return charset.end()
    head_open = _HEAD_OPEN.search(document)
    if head_open:
        return head_open.end()
    html_open = _HTML_OPEN.search(document)
    if html_open:
        return html_open.end()
    return 0
