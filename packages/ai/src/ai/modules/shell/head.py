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
canonical link, robots meta and Open Graph title/description/url. Every value
is escaped for its context: page titles are manifest text entering a
platform-origin document, so escaping is a security boundary.
"""

import html
import re

_FLAGS = re.IGNORECASE | re.DOTALL


def _tag_with(tag: str, attr: str, value: str) -> re.Pattern:
    """A <tag ...> whose attr equals value (any attribute order/quoting)."""
    return re.compile(rf'<{tag}\b(?=[^>]*\b{attr}\s*=\s*["\']?{re.escape(value)}["\'\s/>])[^>]*>\s*', _FLAGS)


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


def inject_head(
    document: str,
    *,
    title: str,
    description: str = '',
    canonical: str = '',
    noindex: bool = False,
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
    block = ''.join(parts)
    match = (
        _CHARSET.search(document, start, start + len(region))
        or _HEAD_OPEN.search(document)
        or _HTML_OPEN.search(document)
    )
    if match:
        return document[: match.end()] + block + document[match.end() :]
    return block + document
