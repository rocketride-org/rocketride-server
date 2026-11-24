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

import codecs
import re
import xml.etree.ElementTree as ET
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union
from urllib.parse import urljoin, urlsplit
from xml.parsers import expat

from bs4 import BeautifulSoup, Comment, Doctype, NavigableString, ProcessingInstruction, Tag
from soupsieve import SelectorSyntaxError

HTML_PARSER = 'html.parser'
_STRIP_TAGS = ('script', 'style', 'noscript', 'template', 'svg', 'iframe')
_WS = re.compile(r'[ \t\r\f\v]+')
_BLANKS = re.compile(r'\n{3,}')
_PATH_TOKEN = re.compile(r'([^.\[\]]+)|\[(\d+)\]')
# The most links page_links returns.
MAX_LINKS = 200
# A byte order mark names the encoding itself (a UTF-32 mark starts with a UTF-16 one).
_BOMS = (codecs.BOM_UTF8, codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)
_ATOM = '{http://www.w3.org/2005/Atom}'
# The root element of a feed, without its namespace, in lower case: RSS 2.0, Atom, RSS 1.0 (rdf:RDF).
_FEED_ROOTS = ('rss', 'feed', 'rdf')


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


def _holds_html(element: ET.Element) -> bool:
    """Whether a feed element's text is HTML, whose markup is stripped.

    An Atom text construct declares its kind (RFC 4287, section 3.1):
    ``type="text"``, the default, is plain text, so an escaped ``&lt;draft&gt;``
    is the literal ``<draft>``; ``html`` (``text/html`` on ``content``) is
    escaped HTML; ``xhtml`` is inline markup the XML parser has already turned
    into elements, leaving only its text. RSS elements declare nothing and
    carry HTML in practice.
    """
    if not element.tag.startswith(_ATOM):
        return True
    return (element.get('type') or 'text').strip().lower() in ('html', 'text/html')


def _feed_text(entry: ET.Element, *names: str) -> Optional[str]:
    """:func:`_child_text` as plain text: HTML is stripped, other Atom text keeps its characters."""
    for name in names:
        child = _child(entry, name)
        if child is not None:
            text = ''.join(child.itertext()).strip()
            if text:
                return html_to_text(text) if _holds_html(child) else _WS.sub(' ', text)
    return None


def _guid_link(entry: ET.Element) -> Optional[str]:
    """The RSS ``<guid>`` when it is a permalink: an absolute http(s) URL not marked ``isPermaLink="false"``.

    Any other guid (``item-42``, ``tag:example.com,2026:1``) is an opaque id:
    resolved against the feed URL it would make up an article URL and its
    dedup key.
    """
    guid = _child(entry, 'guid')
    if guid is None or (guid.get('isPermaLink') or '').strip().lower() == 'false':
        return None
    text = ''.join(guid.itertext()).strip()
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    return text if parts.scheme in ('http', 'https') and parts.netloc else None


_XML_BASE = '{http://www.w3.org/XML/1998/namespace}base'


def _with_base(base: Optional[str], element: ET.Element) -> Optional[str]:
    """The effective ``xml:base`` inside ``element``, given its parent's."""
    value = element.get(_XML_BASE)
    if not value:
        return base
    return _resolve(base, value)


def join_url(base: str, ref: str) -> Optional[str]:
    """``ref`` resolved against ``base``, or None when it does not parse.

    ``urljoin`` raises ``ValueError`` for some malformed URLs (``https://[``);
    one such link must cost only that link, never the page or the source.
    """
    try:
        return urljoin(base, ref)
    except ValueError:
        return None


def _resolve(base: Optional[str], ref: str) -> str:
    """``ref`` resolved against ``base``; a ref that does not parse is left for the row check to drop."""
    if not base:
        return ref
    return join_url(base, ref) or ref


def _feed_entries(root: ET.Element, base_url: Optional[str] = None) -> List[Tuple[ET.Element, Optional[str]]]:
    """Every item / entry in document order, with the ``xml:base`` in effect there (RFC 4287).

    ElementTree keeps no parent links, so the base is carried down an explicit
    stack while walking the tree.
    """
    found: List[Tuple[ET.Element, Optional[str]]] = []
    stack = [(root, _with_base(base_url, root))]
    while stack:
        element, base = stack.pop()
        if _local(element.tag) in ('item', 'entry'):
            found.append((element, base))
        for child in reversed(list(element)):
            stack.append((child, _with_base(base, child)))
    return found


def _atom_link(entry: ET.Element, base: Optional[str] = None) -> Optional[str]:
    """The entry's article link, resolved against the ``xml:base`` in effect on the link element."""
    fallback = None
    for child in entry:
        if _local(child.tag) != 'link':
            continue
        link_base = _with_base(base, child)
        href = child.get('href')
        if not href:
            text = (child.text or '').strip()
            if text:
                return _resolve(link_base, text)
            continue
        rel = child.get('rel', 'alternate')
        if rel == 'alternate':
            return _resolve(link_base, href)
        fallback = fallback or _resolve(link_base, href)
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


def parse_feed(content: Union[bytes, str], base_url: Optional[str] = None) -> List[Dict[str, Any]]:
    """Parse an RSS or Atom document into normalized raw items.

    Each item has ``title``, ``url``, ``author``, ``published``, ``body``
    and ``categories``; ``title`` and ``body`` are text (see
    :func:`_holds_html`). ``base_url`` is the URL the feed was fetched from:
    a relative ``xml:base`` (``../``) resolves against it, as RFC 4287
    requires.

    Raises:
        ValueError: The document is not a feed, declares entities, or names
            an encoding Python does not know.
    """
    if isinstance(content, str):
        content = content.encode('utf-8')
    try:
        _refuse_entity_declarations(content)
        root = ET.fromstring(content)
    except LookupError as e:
        # Either parser pass: expat looks up the encoding the XML declaration names.
        raise ValueError(f'Feed declares an unsupported encoding: {e}') from e
    except ET.ParseError as e:
        raise ValueError(f'Not a valid RSS/Atom document: {e}') from e
    # Well-formed XML that is no feed (an XHTML maintenance page) has no items either: it is not an empty feed
    if _local(root.tag).lower() not in _FEED_ROOTS:
        raise ValueError(f'Not an RSS/Atom document: its root element is <{_local(root.tag)}>')

    items: List[Dict[str, Any]] = []
    for entry, base in _feed_entries(root, base_url):
        link = _atom_link(entry, base) or _guid_link(entry)
        categories = []
        for child in entry:
            if _local(child.tag) in ('category', 'subject'):
                term = child.get('term') or (child.text or '').strip()
                if term:
                    categories.append(term)
        items.append(
            {
                'title': _feed_text(entry, 'title') or '',
                'url': link,
                'author': _author(entry),
                'published': _child_text(entry, 'pubDate', 'published', 'updated', 'date', 'issued'),
                'body': _feed_text(entry, 'content', 'encoded', 'summary', 'description'),
                'categories': categories,
            }
        )
    return items


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------


def _transport_codec(charset: Optional[str], content: bytes) -> Optional[str]:
    """The codec for the ``Content-Type`` charset of ``content``; None leaves the choice to the document.

    None when no charset was declared, Python does not know it, or
    ``content`` starts with a byte order mark (which outranks the header).
    The labels the WHATWG Encoding standard reads as windows-1252 (``ascii``,
    ``iso-8859-1``, ``latin1`` ...) decode as cp1252, as browsers do.
    """
    if not charset or content.startswith(_BOMS):
        return None
    try:
        name = codecs.lookup(charset).name
    except (LookupError, ValueError):
        return None
    return 'cp1252' if name in ('ascii', 'iso8859-1') else name


def soup_of(content: Union[bytes, str], encoding: Optional[str] = None) -> BeautifulSoup:
    """Parse HTML; ``encoding`` is the charset the response's ``Content-Type`` declared, if any.

    A declared charset decides how the bytes decode, ahead of a ``<meta
    charset>`` in the page (the WHATWG order). Without one BeautifulSoup
    detects the encoding from the document, as it always has.
    """
    if isinstance(content, bytes):
        codec = _transport_codec(encoding, content)
        if codec:
            try:
                content = content.decode(codec, errors='replace')
            except (LookupError, UnicodeError):
                # A codec that is not a text encoding (``base64``), or one that cannot
                # decode with ``errors='replace'`` (``idna``): detect instead
                pass
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


def _split_attr(spec: str) -> Tuple[str, str]:
    """Split ``"selector@attr"`` at the last ``@`` outside CSS quotes and brackets.

    An ``@`` inside an attribute selector (``a[href*="@"]@href``) belongs to
    the selector.
    """
    quote = ''
    depth = 0
    at = -1
    index = 0
    while index < len(spec):
        ch = spec[index]
        if ch == '\\':
            index += 2
            continue
        if quote:
            if ch == quote:
                quote = ''
        elif ch in ('"', "'"):
            quote = ch
        elif ch == '[':
            depth += 1
        elif ch == ']':
            depth = max(depth - 1, 0)
        elif ch == '@' and depth == 0:
            at = index
        index += 1
    if at < 0:
        return spec, ''
    return spec[:at], spec[at + 1 :]


def _select_value(scope: Tag, spec: str, base_url: str) -> Optional[str]:
    """Evaluate ``"css selector@attr"``; ``"@attr"`` reads the scope element itself.

    Without ``@attr`` the element's text is returned. ``href`` / ``src``
    attributes are resolved against ``base_url``.
    """
    selector, attr = _split_attr(spec)
    selector = selector.strip()
    el = _select_one(scope, selector) if selector else scope
    if el is None:
        return None
    if attr:
        value = el.get(attr.strip())
        if isinstance(value, list):
            value = ' '.join(value)
        if value and attr.strip() in ('href', 'src'):
            value = join_url(base_url, value)
        return value.strip() if isinstance(value, str) else value
    text = _WS.sub(' ', el.get_text(' ')).strip()
    return text or None


def extract_html_items(
    content: Union[bytes, str],
    base_url: str,
    item_selector: str,
    fields: Dict[str, Any],
    encoding: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Select repeated items with ``item_selector`` and map each field selector.

    ``encoding`` is the response's declared charset (see :func:`soup_of`).
    """
    soup = soup_of(content, encoding)
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


def _clean_soup(content: Union[bytes, str], encoding: Optional[str] = None) -> BeautifulSoup:
    soup = soup_of(content, encoding)
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


def page_to_text(
    content: Union[bytes, str], selector: Optional[str] = None, encoding: Optional[str] = None
) -> Dict[str, Any]:
    soup = _clean_soup(content, encoding)
    node = _main_node(soup, selector)
    lines = [_WS.sub(' ', line).strip() for line in node.get_text('\n').splitlines()]
    text = _BLANKS.sub('\n\n', '\n'.join(line for line in lines if line))
    return {'title': page_title(soup), 'description': page_description(soup), 'content': text}


def page_links(
    content: Union[bytes, str], base_url: str, limit: int = MAX_LINKS, encoding: Optional[str] = None
) -> List[Dict[str, str]]:
    soup = soup_of(content, encoding)
    seen = set()
    links = []
    for a in soup.find_all('a', href=True):
        href = join_url(base_url, a['href'])
        if not href or not href.startswith(('http://', 'https://')) or href in seen:
            continue
        seen.add(href)
        links.append({'url': href, 'text': _WS.sub(' ', a.get_text(' ')).strip()})
        if len(links) >= limit:
            break
    return links


# Markdown conversion recurses once per nesting level; deeper subtrees are
# emitted as plain text (``get_text`` walks iteratively) so a hostile or broken
# page cannot raise RecursionError.
_MAX_MD_DEPTH = 200
# Not page content. CData is deliberately absent: it can hold real text.
_NON_CONTENT = (Comment, Doctype, ProcessingInstruction)


def _md_inline(node: Any, base_url: str, depth: int = 0) -> str:
    if isinstance(node, _NON_CONTENT):
        return ''
    if isinstance(node, NavigableString):
        return _WS.sub(' ', str(node))
    if not isinstance(node, Tag):
        return ''
    if depth >= _MAX_MD_DEPTH:
        return _WS.sub(' ', node.get_text(' '))
    inner = ''.join(_md_inline(c, base_url, depth + 1) for c in node.children)
    name = node.name
    if name == 'a' and node.get('href'):
        text = inner.strip()
        href = join_url(base_url, node['href'])
        if not text or not href:
            return text  # a link that does not parse keeps its text
        return f'[{text}]({href})'
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
        if not node.get('src'):
            return ''
        src = join_url(base_url, node['src'])
        if not src:
            return alt  # an image URL that does not parse keeps its alt text
        return f'![{alt}]({src})'
    return inner


_BLOCKS = ('p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'blockquote', 'figure', 'table')


def _md_block(node: Tag, base_url: str, out: List[str], depth: int = 0) -> None:
    if depth >= _MAX_MD_DEPTH:
        text = _WS.sub(' ', node.get_text(' ')).strip()
        if text:
            out.append(text)
        return
    for child in node.children:
        if isinstance(child, _NON_CONTENT):
            continue
        if isinstance(child, NavigableString):
            text = _WS.sub(' ', str(child)).strip()
            if text:
                out.append(text)
            continue
        if not isinstance(child, Tag):
            continue
        name = child.name
        if name in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            text = _md_inline(child, base_url, depth + 1).strip()
            if text:
                out.append(f'{"#" * int(name[1])} {text}')
        elif name in ('ul', 'ol'):
            for i, li in enumerate(child.find_all('li', recursive=False), 1):
                bullet = f'{i}.' if name == 'ol' else '-'
                text = _md_inline(li, base_url, depth + 2).strip()
                if text:
                    out.append(f'{bullet} {text}')
        elif name == 'pre':
            out.append('```\n' + child.get_text().strip('\n') + '\n```')
        elif name == 'p':
            text = _md_inline(child, base_url, depth + 1).strip()
            if text:
                out.append(text)
        elif name in _BLOCKS:
            _md_block(child, base_url, out, depth + 1)
        else:
            text = _md_inline(child, base_url, depth + 1).strip()
            if text:
                out.append(text)


def page_to_markdown(
    content: Union[bytes, str], base_url: str, selector: Optional[str] = None, encoding: Optional[str] = None
) -> Dict[str, Any]:
    soup = _clean_soup(content, encoding)
    node = _main_node(soup, selector)
    blocks: List[str] = []
    _md_block(node, base_url, blocks)
    text = _BLANKS.sub('\n\n', '\n\n'.join(blocks)).strip()
    return {'title': page_title(soup), 'description': page_description(soup), 'content': text}
