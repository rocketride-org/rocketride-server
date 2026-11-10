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
BlogPosting JSON-LD for dated public pages.

A page that declares ``published`` is an article: crawlers get a BlogPosting
naming its headline (its own title, without the site's brand suffix), dates,
authors, image and canonical URL. Its publisher is the site's organization:
a reference to the ``@id`` of the Organization node the root owner's
``site.organization`` declares, else an inline Organization named after
``site.title`` on the ``RR_APP_URL`` origin. A post without authors is by its
publisher. Serialization (``head.jsonld_script``) escapes ``<``, ``>`` and
``&``, so no value can close the script element.
"""

from typing import Any, Dict, Mapping
from urllib.parse import urlsplit

from .contract import Page, own_title
from .shell import app_url


def publisher(site: Mapping[str, Any]) -> Dict[str, Any]:
    """The site's organization, as an ``@id`` reference when ``site.organization`` declares one, else inline.

    The inline organization is named after ``site.title`` (else the origin's
    host), on the ``RR_APP_URL`` origin.
    """
    organization = site.get('organization')
    if organization:
        # check_manifest keeps site.organization only with an https url.
        return {'@id': f'{organization["url"]}#organization'}
    base = app_url()
    out: Dict[str, Any] = {'@type': 'Organization'}
    name = site.get('title') or urlsplit(base).netloc
    if name:
        out['name'] = name
    if base:
        out['url'] = f'{base}/'
    return out


def blogposting(page: Page, site: Mapping[str, Any], *, canonical: str, image: str) -> Dict[str, Any]:
    """The BlogPosting of a page with ``published``.

    ``canonical`` and ``image`` are the absolute URLs the head carries (''
    when there is none); ``headline`` is the title without the site's
    `` | <site.title>`` suffix; ``dateModified`` is ``modified``, else
    ``published``.
    """
    organization = publisher(site)
    authors = []
    for name, url in page.authors:
        author = {'@type': 'Person', 'name': name}
        if url:
            author['url'] = url
        authors.append(author)
    out: Dict[str, Any] = {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        'headline': own_title(page.title, site.get('title', '')),
        'datePublished': page.published,
        'dateModified': page.modified or page.published,
        'author': authors or organization,
        'publisher': organization,
    }
    if page.description:
        out['description'] = page.description
    if image:
        out['image'] = image
    if canonical:
        out['mainEntityOfPage'] = canonical
    return out
