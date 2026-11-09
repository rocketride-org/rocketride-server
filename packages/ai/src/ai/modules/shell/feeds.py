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
Atom 1.0 feeds of dated public pages (``site.feeds``).

The root owner declares each feed as ``{path, prefix, title}``. A feed lists
the listed pages strictly under ``prefix`` that declare ``published``,
newest first (then by path), at most ``MAX_ENTRIES``. Each entry carries the
page's canonical URL as its id and link, its title (without the site's
`` | <site.title>`` suffix), ``published``, ``updated`` (``modified``, else
``published``) as RFC 3339, its description as the summary and one author
per declared author; the feed's own author (``site.title``, else the
origin's host) stands for entries without one. The feed is as new as its
newest entry, else as the aggregate.

Manifest text is text: every value is XML-escaped, and characters XML 1.0
cannot carry are dropped, so the document is well-formed whatever a title,
description or author holds.
"""

import re
from datetime import datetime, timezone
from typing import Any, List
from urllib.parse import urlsplit
from xml.sax.saxutils import escape, quoteattr

from .contract import Page, page_instant
from .shell import own_title

MAX_ENTRIES = 50

# Everything XML 1.0 cannot carry: C0 controls, surrogates, U+FFFE and U+FFFF.
_NOT_XML = re.compile(r'[^\t\n\r\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]')


def _text(value: str) -> str:
    return escape(_NOT_XML.sub('', value))


def _attr(value: str) -> str:
    return quoteattr(_NOT_XML.sub('', value))


def rfc3339(value: str) -> str:
    """A page date as an RFC 3339 date-time: a date alone is midnight UTC."""
    return value if 'T' in value else f'{value}T00:00:00Z'


def entries(feed: Any, pages: List[Page]) -> List[Page]:
    """The pages ``feed`` lists, newest first (then by path), at most ``MAX_ENTRIES``."""
    prefix = feed['prefix']
    dated = [p for p in pages if p.listed and p.published and p.path.startswith(prefix) and p.path != prefix]
    dated.sort(key=lambda p: (-page_instant(p.published).timestamp(), p.path))
    return dated[:MAX_ENTRIES]


def atom(feed: Any, aggregate: Any, base: str) -> str:
    """The Atom document of ``feed`` over ``aggregate``'s pages, with absolute URLs on ``base`` (RR_APP_URL)."""
    items = entries(feed, aggregate.pages())
    site_title = aggregate.site.get('title', '')
    newest = max((p.modified or p.published for p in items), key=page_instant, default='')
    if newest:
        updated = rfc3339(newest)
    else:
        updated = datetime.fromtimestamp(aggregate.built_at, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    self_url = base + feed['path']
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        f'<id>{_text(self_url)}</id>',
        f'<title>{_text(feed["title"])}</title>',
        f'<updated>{_text(updated)}</updated>',
        f'<link rel="self" type="application/atom+xml" href={_attr(self_url)}/>',
        f'<link rel="alternate" type="text/html" href={_attr(base + (feed["prefix"][:-1] or "/"))}/>',
        f'<author><name>{_text(site_title or urlsplit(base).netloc)}</name></author>',
    ]
    for page in items:
        url = base + page.path
        lines += [
            '<entry>',
            f'<id>{_text(url)}</id>',
            f'<title>{_text(own_title(page.title, site_title))}</title>',
            f'<link rel="alternate" type="text/html" href={_attr(url)}/>',
            f'<published>{_text(rfc3339(page.published))}</published>',
            f'<updated>{_text(rfc3339(page.modified or page.published))}</updated>',
        ]
        if page.description:
            lines.append(f'<summary>{_text(page.description)}</summary>')
        for name, uri in page.authors:
            lines.append(f'<author><name>{_text(name)}</name>{f"<uri>{_text(uri)}</uri>" if uri else ""}</author>')
        lines.append('</entry>')
    lines.append('</feed>')
    return '\n'.join(lines) + '\n'
