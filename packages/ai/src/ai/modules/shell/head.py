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
canonical link, robots meta, Open Graph and Twitter card tags and article
times, and inserts JSON-LD blocks and pre-escaped extra tags. Every value is
escaped for its context: page titles are manifest text entering a
platform-origin document, so escaping is a security boundary.
"""

import html
import json
import re
from typing import Any, Iterable, List, Mapping, Tuple

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
    _tag_with('meta', 'property', 'og:type'),
    _tag_with('meta', 'property', 'og:site_name'),
    _tag_with('meta', 'property', 'og:image'),
    _tag_with('meta', 'name', 'twitter:card'),
    _tag_with('meta', 'name', 'twitter:image'),
    _tag_with('meta', 'name', 'twitter:image:alt'),
    _tag_with('meta', 'property', 'article:published_time'),
    _tag_with('meta', 'property', 'article:modified_time'),
)
# The replaced tags, after a script or style element: tried first at each
# position, such an element is matched whole and kept, so its text (a
# '<title>' string in a script) is never taken for a tag.
_REMOVED = re.compile(
    rf'(?P<kept><(?P<raw>script|style)(?=[\s/>]){_ATTR_UNIT}*>.*?</(?P=raw)\s*>)|'
    + '|'.join(p.pattern for p in _REPLACED),
    _FLAGS,
)
_HEAD_OPEN = re.compile(r'<head\b[^>]*>', re.IGNORECASE)
_CHARSET = re.compile(r'<meta\b[^>]*?(?:\bcharset\s*=|\bhttp-equiv\s*=\s*["\']?content-type\b)[^>]*>', re.IGNORECASE)
_VIEWPORT = _tag_with('meta', 'name', 'viewport')
# The viewport tag, after a script or style element: as in _REMOVED, such an
# element is matched whole first, so a viewport tag written in a script's
# text is never taken for the document's own.
_VIEWPORT_OR_RAW = re.compile(
    rf'(?P<kept><(?P<raw>script|style)(?=[\s/>]){_ATTR_UNIT}*>.*?</(?P=raw)\s*>)|(?P<viewport>{_VIEWPORT.pattern})',
    _FLAGS,
)
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


def social_tags(*, site_name: str = '', image: str = '', published: str = '', modified: str = '') -> List[str]:
    """Link-preview tags for ``inject_head``'s ``extra``, escaped.

    ``og:type`` is ``article`` for a page with a publication time (which
    also gets ``article:published_time`` and ``article:modified_time``,
    the latter defaulting to the former), else ``website``. An ``image``
    (an absolute URL) asks for the large Twitter card.

    Args:
        site_name: ``site.title``; no ``og:site_name`` when empty.
        image: The absolute preview image URL; none when empty.
        published: The page's ``published``; makes the page an article.
        modified: The page's ``modified``; defaults to ``published``.

    Returns:
        Complete, escaped tags for ``inject_head``'s ``extra``.
    """
    og_type = 'website'
    if published:
        og_type = 'article'
    tags = [f'<meta property="og:type" content="{og_type}">']
    if site_name:
        tags.append(f'<meta property="og:site_name" content="{_attr(site_name)}">')
    if image:
        tags.append(f'<meta property="og:image" content="{_attr(image)}">')
    card = 'summary'
    if image:
        card = 'summary_large_image'
    tags.append(f'<meta name="twitter:card" content="{card}">')
    if published:
        tags.append(f'<meta property="article:published_time" content="{_attr(published)}">')
        tags.append(f'<meta property="article:modified_time" content="{_attr(modified or published)}">')
    return tags


def feed_links(feeds: Iterable[Tuple[str, str]]) -> List[str]:
    """One ``<link rel="alternate">`` per Atom feed ``(title, href)``, escaped, for ``inject_head``'s ``extra``.

    Args:
        feeds: ``(title, absolute href)`` pairs, one per feed.

    Returns:
        One escaped ``<link>`` tag per feed.
    """
    return [
        f'<link rel="alternate" type="application/atom+xml" title="{_attr(title)}" href="{_attr(href)}">'
        for title, href in feeds
    ]


def inject_head(
    document: str,
    *,
    title: str,
    description: str = '',
    canonical: str = '',
    noindex: bool = False,
    jsonld: Iterable[Mapping[str, Any]] = (),
    extra: Iterable[str] = (),
    responsive_preloads: Iterable[str] = (),
) -> str:
    """Return ``document`` with the page's head metadata in place.

    Existing tags of the same kinds are removed first; the new block goes
    right after the head's charset declaration, which must stay within the
    document's first 1024 bytes, else right after <head> (or after <html>,
    or at the very start). Responsive preloads go after the viewport. Tag
    strings supplied in ``extra`` and ``responsive_preloads`` are already escaped.

    Args:
        document: The HTML document (the shell's, or a page snapshot).
        title: The document title; also ``og:title``.
        description: The meta description and ``og:description``; none when empty.
        canonical: The absolute canonical URL and ``og:url``; none when empty.
        noindex: Whether to add ``<meta name="robots" content="noindex">``.
        jsonld: JSON-LD nodes, one ``<script type="application/ld+json">``
            each (``jsonld_script``).
        extra: Complete, already-escaped tags, appended to the block verbatim.
        responsive_preloads: Complete tags that depend on the document viewport.

    Returns:
        The document with the new block in its head.
    """
    # Only the head's tags are replaced: an inline SVG <title> in the body,
    # or a '<title>' string in a script (in the head too), is content.
    # Without a <head>, the region before <body> stands in for it.
    span = _HEAD_SPAN.search(document)
    if span:
        start, end = span.span()
    else:
        start, end = 0, len(document)
        body = _BODY_OPEN.search(document)
        if body:
            end = body.start()
    region = _REMOVED.sub(lambda m: m.group('kept') or '', document[start:end])
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
    parts.extend(extra)
    block = ''.join(parts)
    at = _insertion_point(document, start, start + len(region))
    document = document[:at] + block + document[at:]
    preload_block = ''.join(responsive_preloads)
    if preload_block:
        # The first viewport tag that is markup, not text inside a script or style
        found = _VIEWPORT_OR_RAW.finditer(document, start, start + len(region) + len(block))
        viewport = next((m for m in found if m.group('viewport')), None)
        preload_at = viewport.end() if viewport else at + len(block)
        document = document[:preload_at] + preload_block + document[preload_at:]
    return document


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
