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

"""Content extraction for scraper_beautifulsoup.

* ``get_path`` / ``extract_json_items`` — dot-path lookups into JSON APIs.
* ``parse_feed`` — RSS 2.0, RSS 1.0 (RDF) and Atom via the stdlib XML parser
  (no DTD / external entity processing).
* ``extract_html_items`` — CSS-selector driven item lists from HTML pages.
* ``page_to_text`` / ``page_to_markdown`` / ``page_links`` — whole-page views
  used by the agent tools.

No engine imports: unit-testable standalone.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, Iterable, List, Optional, Union
from urllib.parse import urljoin
from xml.parsers import expat

from bs4 import BeautifulSoup, NavigableString, Tag
from soupsieve import SelectorSyntaxError

HTML_PARSER = 'html.parser'
_STRIP_TAGS = ('script', 'style', 'noscript', 'template', 'svg', 'iframe')
_WS = re.compile(r'[ \t\r\f\v]+')
_BLANKS = re.compile(r'\n{3,}')
_PATH_TOKEN = re.compile(r'([^.\[\]]+)|\[(\d+)\]')


# ---------------------------------------------------------------------------
# JSON
# ---------------------------------------------------------------------------


def get_path(obj: Any, path: str) -> Any:
    """Resolve a dot path such as ``data.children`` or ``items[0].name``.

    An empty path returns ``obj``. Missing keys / indexes return ``None``.
    """
    if path is None or path == '' or path == '.':
        return obj
    current = obj
    for key, index in _PATH_TOKEN.findall(path):
        if current is None:
            return None
        if index:
            if not isinstance(current, list):
                return None
            i = int(index)
            current = current[i] if i < len(current) else None
        elif isinstance(current, dict):
            current = current.get(key)
        elif isinstance(current, list) and key.isdigit():
            i = int(key)
            current = current[i] if i < len(current) else None
        else:
            return None
    return current


def first_value(obj: Any, spec: Union[str, List[str], None]) -> Any:
    """Return the first non-empty value among one or more fallback paths."""
    if spec is None:
        return None
    for path in [spec] if isinstance(spec, str) else list(spec):
        value = get_path(obj, path)
        if value not in (None, '', [], {}):
            return value
    return None


def extract_json_items(data: Any, items_path: str, fields: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Pull an item list out of a JSON document and map each item's fields."""
    items = get_path(data, items_path or '')
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        return []
    out = []
    for item in items:
        out.append({name: first_value(item, spec) for name, spec in (fields or {}).items()})
    return out


# ---------------------------------------------------------------------------
# Feeds
# ---------------------------------------------------------------------------


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1] if isinstance(tag, str) else ''


def _child(el: ET.Element, *names: str) -> Optional[ET.Element]:
    for child in el:
        if _local(child.tag) in names:
            return child
    return None


def _child_text(el: ET.Element, *names: str) -> Optional[str]:
    for name in names:
        child = _child(el, name)
        if child is not None:
            text = ''.join(child.itertext()).strip()
            if text:
                return text
    return None


def _atom_link(entry: ET.Element) -> Optional[str]:
    fallback = None
    for child in entry:
        if _local(child.tag) != 'link':
            continue
        href = child.get('href')
        if not href:
            text = (child.text or '').strip()
            if text:
                return text
            continue
        rel = child.get('rel', 'alternate')
        if rel == 'alternate':
            return href
        fallback = fallback or href
    return fallback


def _author(entry: ET.Element) -> Optional[str]:
    author = _child(entry, 'author')
    if author is not None:
        name = _child_text(author, 'name')
        if name:
            return name
        text = ''.join(author.itertext()).strip()
        if text:
            return text
    return _child_text(entry, 'creator')


def _refuse_entity_declarations(content: bytes) -> None:
    """Reject any document whose DTD declares entities (entity-expansion attacks).

    A bare ``<!DOCTYPE>`` (e.g. RSS 0.91's Netscape DTD) is allowed; expat never
    fetches external DTDs. The pre-scan uses a real parser, so declarations
    are caught wherever they sit in the prolog.
    """

    def refuse(*_args: Any) -> None:
        raise ValueError('Feed DTD declares entities; refusing to parse')

    parser = expat.ParserCreate()
    parser.EntityDeclHandler = refuse
    try:
        parser.Parse(content, True)
    except expat.ExpatError:
        pass  # malformed documents are reported by the real parse below


def parse_feed(content: Union[bytes, str]) -> List[Dict[str, Any]]:
    """Parse an RSS or Atom document into normalized raw items.

    Each item has ``title``, ``url``, ``author``, ``published``, ``body``
    (HTML stripped to text) and ``categories``.
    """
    if isinstance(content, str):
        content = content.encode('utf-8')
    _refuse_entity_declarations(content)
    try:
        root = ET.fromstring(content)
    except ET.ParseError as e:
        raise ValueError(f'Not a valid RSS/Atom document: {e}') from e

    entries = [el for el in root.iter() if _local(el.tag) in ('item', 'entry')]
    items: List[Dict[str, Any]] = []
    for entry in entries:
        link = _atom_link(entry) or _child_text(entry, 'guid')
        body_raw = _child_text(entry, 'content', 'encoded', 'summary', 'description')
        categories = []
        for child in entry:
            if _local(child.tag) in ('category', 'subject'):
                term = child.get('term') or (child.text or '').strip()
                if term:
                    categories.append(term)
        items.append(
            {
                'title': html_to_text(_child_text(entry, 'title') or ''),
                'url': link,
                'author': _author(entry),
                'published': _child_text(entry, 'pubDate', 'published', 'updated', 'date', 'issued'),
                'body': html_to_text(body_raw) if body_raw else None,
                'categories': categories,
            }
        )
    return items


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------


def soup_of(content: Union[bytes, str]) -> BeautifulSoup:
    return BeautifulSoup(content, HTML_PARSER)


def _select(scope: Tag, selector: str) -> List[Tag]:
    try:
        return scope.select(selector)
    except SelectorSyntaxError as e:
        raise ValueError(f'Invalid CSS selector {selector!r}: {e}') from e


def _select_one(scope: Tag, selector: str) -> Optional[Tag]:
    try:
        return scope.select_one(selector)
    except SelectorSyntaxError as e:
        raise ValueError(f'Invalid CSS selector {selector!r}: {e}') from e


def html_to_text(value: Optional[str]) -> str:
    """Strip markup from an HTML fragment and collapse whitespace."""
    if not value:
        return ''
    if '<' not in value and '&' not in value:
        return _WS.sub(' ', value).strip()
    soup = soup_of(value)
    for tag in soup(_STRIP_TAGS):
        tag.decompose()
    return _WS.sub(' ', soup.get_text(' ')).strip()


def _select_value(scope: Tag, spec: str, base_url: str) -> Optional[str]:
    """Evaluate ``"css selector@attr"``; ``"@attr"`` reads the scope element itself.

    Without ``@attr`` the element's text is returned. ``href`` / ``src``
    attributes are resolved against ``base_url``.
    """
    selector, _, attr = spec.partition('@')
    selector = selector.strip()
    el = _select_one(scope, selector) if selector else scope
    if el is None:
        return None
    if attr:
        value = el.get(attr.strip())
        if isinstance(value, list):
            value = ' '.join(value)
        if value and attr.strip() in ('href', 'src'):
            value = urljoin(base_url, value)
        return value.strip() if isinstance(value, str) else value
    text = _WS.sub(' ', el.get_text(' ')).strip()
    return text or None


def extract_html_items(
    content: Union[bytes, str], base_url: str, item_selector: str, fields: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """Select repeated items with ``item_selector`` and map each field selector."""
    soup = soup_of(content)
    scopes: Iterable[Tag] = _select(soup, item_selector) if item_selector else [soup]
    out = []
    for scope in scopes:
        row = {}
        for name, spec in (fields or {}).items():
            specs = [spec] if isinstance(spec, str) else list(spec or [])
            value = None
            for s in specs:
                value = _select_value(scope, s, base_url)
                if value:
                    break
            row[name] = value
        out.append(row)
    return out


def _clean_soup(content: Union[bytes, str]) -> BeautifulSoup:
    soup = soup_of(content)
    for tag in soup(_STRIP_TAGS):
        tag.decompose()
    return soup


def page_title(soup: BeautifulSoup) -> Optional[str]:
    if soup.title and soup.title.string:
        return soup.title.string.strip()
    og = soup.find('meta', attrs={'property': 'og:title'})
    return og.get('content').strip() if og and og.get('content') else None


def page_description(soup: BeautifulSoup) -> Optional[str]:
    for attrs in ({'name': 'description'}, {'property': 'og:description'}):
        meta = soup.find('meta', attrs=attrs)
        if meta and meta.get('content'):
            return meta['content'].strip()
    return None


def _main_node(soup: BeautifulSoup, selector: Optional[str] = None) -> Tag:
    if selector:
        found = _select_one(soup, selector)
        if found is not None:
            return found
    return soup.find('main') or soup.find('article') or soup.body or soup


def page_to_text(content: Union[bytes, str], selector: Optional[str] = None) -> Dict[str, Any]:
    soup = _clean_soup(content)
    node = _main_node(soup, selector)
    lines = [_WS.sub(' ', line).strip() for line in node.get_text('\n').splitlines()]
    text = _BLANKS.sub('\n\n', '\n'.join(line for line in lines if line))
    return {'title': page_title(soup), 'description': page_description(soup), 'content': text}


def page_links(content: Union[bytes, str], base_url: str, limit: int = 200) -> List[Dict[str, str]]:
    soup = soup_of(content)
    seen = set()
    links = []
    for a in soup.find_all('a', href=True):
        href = urljoin(base_url, a['href'])
        if not href.startswith(('http://', 'https://')) or href in seen:
            continue
        seen.add(href)
        links.append({'url': href, 'text': _WS.sub(' ', a.get_text(' ')).strip()})
        if len(links) >= limit:
            break
    return links


def _md_inline(node: Any, base_url: str) -> str:
    if isinstance(node, NavigableString):
        return _WS.sub(' ', str(node))
    if not isinstance(node, Tag):
        return ''
    inner = ''.join(_md_inline(c, base_url) for c in node.children)
    name = node.name
    if name == 'a' and node.get('href'):
        text = inner.strip()
        return f'[{text}]({urljoin(base_url, node["href"])})' if text else ''
    if name in ('strong', 'b'):
        return f'**{inner.strip()}**' if inner.strip() else ''
    if name in ('em', 'i'):
        return f'*{inner.strip()}*' if inner.strip() else ''
    if name == 'code':
        return f'`{inner.strip()}`' if inner.strip() else ''
    if name == 'br':
        return '\n'
    if name == 'img':
        alt = node.get('alt', '')
        src = node.get('src')
        return f'![{alt}]({urljoin(base_url, src)})' if src else ''
    return inner


_BLOCKS = ('p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'blockquote', 'figure', 'table')


def _md_block(node: Tag, base_url: str, out: List[str]) -> None:
    for child in node.children:
        if isinstance(child, NavigableString):
            text = _WS.sub(' ', str(child)).strip()
            if text:
                out.append(text)
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            text = _md_inline(child, base_url).strip()
            if text:
                out.append(f'{"#" * int(name[1])} {text}')
        elif name in ('ul', 'ol'):
            for i, li in enumerate(child.find_all('li', recursive=False), 1):
                bullet = f'{i}.' if name == 'ol' else '-'
                text = _md_inline(li, base_url).strip()
                if text:
                    out.append(f'{bullet} {text}')
        elif name == 'pre':
            out.append('```\n' + child.get_text().strip('\n') + '\n```')
        elif name == 'p':
            text = _md_inline(child, base_url).strip()
            if text:
                out.append(text)
        elif name in _BLOCKS:
            _md_block(child, base_url, out)
        else:
            text = _md_inline(child, base_url).strip()
            if text:
                out.append(text)


def page_to_markdown(content: Union[bytes, str], base_url: str, selector: Optional[str] = None) -> Dict[str, Any]:
    soup = _clean_soup(content)
    node = _main_node(soup, selector)
    blocks: List[str] = []
    _md_block(node, base_url, blocks)
    text = _BLANKS.sub('\n\n', '\n\n'.join(blocks)).strip()
    return {'title': page_title(soup), 'description': page_description(soup), 'content': text}
