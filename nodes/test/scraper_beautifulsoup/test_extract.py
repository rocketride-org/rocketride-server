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

"""Unit tests for scraper_beautifulsoup content extraction (no engine needed)."""

from __future__ import annotations

import codecs
import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / 'src' / 'nodes' / 'scraper_beautifulsoup'))

from scrape_extract import (  # noqa: E402
    extract_html_items,
    extract_json_items,
    get_path,
    html_to_text,
    page_links,
    page_to_markdown,
    page_to_text,
    parse_feed,
)

RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Blog</title>
<item>
  <title>First &amp; best</title>
  <link>https://example.com/a</link>
  <dc:creator>Ada</dc:creator>
  <pubDate>Tue, 10 Jun 2025 08:00:00 GMT</pubDate>
  <description><![CDATA[<p>Hello <b>world</b></p>]]></description>
  <category>ai</category>
</item>
<item>
  <title>No link</title>
  <guid>https://example.com/guid-b</guid>
</item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Paper one</title>
    <link rel="related" href="https://arxiv.org/pdf/1"/>
    <link rel="alternate" href="https://arxiv.org/abs/1"/>
    <author><name>Grace</name></author>
    <published>2025-06-01T12:00:00Z</published>
    <summary>An   abstract.</summary>
    <category term="cs.AI"/>
  </entry>
</feed>"""

RDF = b"""<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item rdf:about="https://arxiv.org/abs/2"><title>RDF item</title><link>https://arxiv.org/abs/2</link><dc:date>2025-06-02</dc:date><dc:creator>Alan</dc:creator></item>
</rdf:RDF>"""

HTML = b"""<html><head><title>Listing</title><meta name="description" content="A listing page"></head>
<body><nav>menu</nav><main>
<h1>Posts</h1>
<article class="post"><h2><a href="/p/1">Post one</a></h2><span class="by">Ann</span><time datetime="2025-06-03">Jun 3</time><p class="sum">Summary one</p></article>
<article class="post"><h2><a href="https://other.org/p/2">Post two</a></h2><p class="sum">Summary two</p></article>
<ul><li>alpha</li><li><a href="/x">beta</a></li></ul>
<script>var x = 1;</script>
</main></body></html>"""


class TestGetPath:
    def test_dot_and_index_paths(self):
        data = {'data': {'children': [{'data': {'title': 'T'}}]}, 'list': [1, 2]}
        assert get_path(data, 'data.children[0].data.title') == 'T'
        assert get_path(data, 'data.children.0.data.title') == 'T'
        assert get_path(data, 'list[1]') == 2

    def test_missing_returns_none(self):
        assert get_path({'a': 1}, 'a.b.c') is None
        assert get_path({'a': []}, 'a[3]') is None

    def test_empty_path_is_identity(self):
        obj = [1]
        assert get_path(obj, '') is obj


class TestJsonItems:
    def test_maps_fields_with_fallbacks(self):
        data = {'hits': [{'title': 'A', 'url': None, 'story_url': 'https://a'}, {'title': 'B', 'url': 'https://b'}]}
        items = extract_json_items(data, 'hits', {'title': 'title', 'url': ['url', 'story_url']})
        assert items == [{'title': 'A', 'url': 'https://a'}, {'title': 'B', 'url': 'https://b'}]

    def test_root_list_and_non_list(self):
        assert extract_json_items([{'u': 1}], '', {'url': 'u'}) == [{'url': 1}]
        assert extract_json_items({'x': 'nope'}, 'x', {'url': 'u'}) == []

    def test_graphql_edges(self):
        data = {
            'data': {'feed': {'edges': [{'node': {'title': 'G', 'url': 'https://g', 'author': {'username': 'u1'}}}]}}
        }
        items = extract_json_items(
            data, 'data.feed.edges', {'title': 'node.title', 'url': 'node.url', 'author': 'node.author.username'}
        )
        assert items == [{'title': 'G', 'url': 'https://g', 'author': 'u1'}]


class TestFeeds:
    def test_rss2(self):
        items = parse_feed(RSS)
        assert len(items) == 2
        first = items[0]
        assert first['title'] == 'First & best'
        assert first['url'] == 'https://example.com/a'
        assert first['author'] == 'Ada'
        assert first['published'] == 'Tue, 10 Jun 2025 08:00:00 GMT'
        assert first['body'] == 'Hello world'
        assert first['categories'] == ['ai']
        assert items[1]['url'] == 'https://example.com/guid-b'

    def test_atom_prefers_alternate_link(self):
        (entry,) = parse_feed(ATOM)
        assert entry['url'] == 'https://arxiv.org/abs/1'
        assert entry['author'] == 'Grace'
        assert entry['body'] == 'An abstract.'
        assert entry['categories'] == ['cs.AI']

    def test_atom_links_resolve_against_xml_base(self):
        atom = b"""<feed xmlns="http://www.w3.org/2005/Atom" xml:base="https://articles.example/posts/">
          <entry><title>One</title><link href="one"/></entry>
          <entry xml:base="archive/"><title>Two</title><link href="two"/></entry>
          <entry><title>Three</title><link xml:base="https://cdn.example/x/" href="three"/></entry>
          <entry><title>Four</title><link href="https://abs.example/four"/></entry>
        </feed>"""
        assert [item['url'] for item in parse_feed(atom)] == [
            'https://articles.example/posts/one',
            'https://articles.example/posts/archive/two',
            'https://cdn.example/x/three',
            'https://abs.example/four',
        ]

    def test_relative_xml_base_resolves_against_the_feed_url(self):
        atom = b"""<feed xmlns="http://www.w3.org/2005/Atom" xml:base="../">
          <entry><link href="one"/></entry>
        </feed>"""
        assert parse_feed(atom, 'https://e.example/feeds/current/feed.xml')[0]['url'] == 'https://e.example/feeds/one'

    def test_feed_without_xml_base_keeps_relative_links(self):
        atom = b'<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="/p/1"/></entry></feed>'
        assert parse_feed(atom)[0]['url'] == '/p/1'

    def test_rss1_rdf(self):
        (entry,) = parse_feed(RDF)
        assert entry['url'] == 'https://arxiv.org/abs/2'
        assert entry['published'] == '2025-06-02'
        assert entry['author'] == 'Alan'

    def test_rejects_dtd(self):
        evil = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title></item></channel></rss>'
        with pytest.raises(ValueError, match='DTD'):
            parse_feed(evil)

    def test_rejects_entity_after_long_prolog(self):
        padding = b'<!--' + b' ' * 4096 + b'-->'
        evil = b'<?xml version="1.0"?>' + padding + b'<!DOCTYPE r [<!ENTITY a "aaaa">]><rss><channel></channel></rss>'
        with pytest.raises(ValueError, match='DTD'):
            parse_feed(evil)

    def test_allows_bare_doctype(self):
        rss091 = (
            b'<?xml version="1.0"?><!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" '
            b'"http://my.netscape.com/publish/formats/rss-0.91.dtd">'
            b'<rss version="0.91"><channel><item><title>Old</title><link>https://example.com/old</link></item></channel></rss>'
        )
        (item,) = parse_feed(rss091)
        assert item['url'] == 'https://example.com/old'

    def test_invalid_xml(self):
        with pytest.raises(ValueError, match='RSS/Atom'):
            parse_feed(b'<html><body>not a feed')

    def test_unknown_encoding_is_a_parse_error(self):
        feed = b'<?xml version="1.0" encoding="x-no-such-codec"?><rss><channel></channel></rss>'
        with pytest.raises(ValueError, match='unsupported encoding'):
            parse_feed(feed)

    @pytest.mark.parametrize(
        'guid',
        [
            '<guid isPermaLink="false">item-42</guid>',
            '<guid>item-42</guid>',
            '<guid isPermaLink="false">https://example.com/p/42</guid>',
            '<guid>tag:example.com,2026:42</guid>',
        ],
    )
    def test_an_opaque_guid_is_not_a_link(self, guid):
        rss = f'<rss version="2.0"><channel><item><title>T</title>{guid}</item></channel></rss>'.encode()
        assert parse_feed(rss, 'https://example.com/feed')[0]['url'] is None

    def test_atom_text_constructs_follow_their_declared_type(self):
        atom = b"""<feed xmlns="http://www.w3.org/2005/Atom">
          <entry><title>Use &lt;draft&gt;</title><link href="https://e.example/1"/>
            <summary type="html">&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</summary></entry>
          <entry><title type="text">a &lt;b&gt; c</title><link href="https://e.example/2"/>
            <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Keep &lt;tags&gt; <b>here</b></p></div></content></entry>
        </feed>"""
        first, second = parse_feed(atom)
        assert (first['title'], first['body']) == ('Use <draft>', 'Hello world')
        assert (second['title'], second['body']) == ('a <b> c', 'Keep <tags> here')


class TestHtml:
    def test_item_selectors_resolve_links(self):
        items = extract_html_items(
            HTML,
            'https://example.com/list',
            'article.post',
            {'title': 'h2', 'url': 'h2 a@href', 'author': '.by', 'published': 'time@datetime', 'body': '.sum'},
        )
        assert items[0] == {
            'title': 'Post one',
            'url': 'https://example.com/p/1',
            'author': 'Ann',
            'published': '2025-06-03',
            'body': 'Summary one',
        }
        assert items[1]['url'] == 'https://other.org/p/2'
        assert items[1]['author'] is None

    def test_self_attribute(self):
        items = extract_html_items(
            b'<a class="x" href="/r">R</a>', 'https://e.com/', 'a.x', {'url': '@href', 'title': ''}
        )
        assert items == [{'url': 'https://e.com/r', 'title': 'R'}]

    def test_at_sign_inside_an_attribute_selector_stays_in_the_selector(self):
        page = b'<a href="mailto:x@y.z">M</a><a href="/p">P</a>'
        fields = {'url': 'a[href*="@"]@href', 'other': "a[href^='/']@href"}
        assert extract_html_items(page, 'https://e.com/', '', fields) == [
            {'url': 'mailto:x@y.z', 'other': 'https://e.com/p'}
        ]

    def test_at_sign_inside_an_attribute_selector_without_attr_reads_text(self):
        page = b'<a href="mailto:x@y.z">Mail</a>'
        assert extract_html_items(page, 'https://e.com/', '', {'title': 'a[href*="@"]'}) == [{'title': 'Mail'}]

    def test_a_malformed_link_costs_only_that_link(self):
        page = b'<main><p><a href="https://[">Bad</a> and <a href="/good">Good</a> <img src="https://[" alt="pic"></p></main>'
        assert [link['url'] for link in page_links(page, 'https://e.com/')] == ['https://e.com/good']
        markdown = page_to_markdown(page, 'https://e.com/')['content']
        assert '[Good](https://e.com/good)' in markdown
        assert 'Bad' in markdown and 'https://[' not in markdown
        assert 'pic' in markdown
        items = extract_html_items(page, 'https://e.com/', 'a', {'title': '', 'url': '@href'})
        assert items == [{'title': 'Bad', 'url': None}, {'title': 'Good', 'url': 'https://e.com/good'}]

    def test_invalid_selector_is_value_error(self):
        with pytest.raises(ValueError, match='Invalid CSS selector'):
            extract_html_items(HTML, 'https://example.com/', 'article[', {'url': 'a@href'})
        with pytest.raises(ValueError, match='Invalid CSS selector'):
            extract_html_items(HTML, 'https://example.com/', 'article', {'url': 'a[@href'})
        with pytest.raises(ValueError, match='Invalid CSS selector'):
            page_to_text(HTML, selector='main[')

    def test_page_text_strips_scripts_and_nav(self):
        view = page_to_text(HTML)
        assert view['title'] == 'Listing'
        assert view['description'] == 'A listing page'
        assert 'var x' not in view['content']
        assert 'menu' not in view['content']  # <main> preferred over <body>
        assert 'Post one' in view['content']

    def test_page_markdown(self):
        view = page_to_markdown(HTML, 'https://example.com/list')
        md = view['content']
        assert '# Posts' in md
        assert '## [Post one](https://example.com/p/1)' in md
        assert '- alpha' in md
        assert '- [beta](https://example.com/x)' in md

    def test_markdown_skips_comments_and_declarations(self):
        html = (
            '<!DOCTYPE html><html><body><main><!-- hidden note --><p>Shown<!-- inline --> text</p>'
            '<?php echo 1; ?><div><![CDATA[kept]]></div></main></body></html>'
        )
        content = page_to_markdown(html, 'https://x/')['content']
        assert 'hidden note' not in content and 'inline' not in content
        assert 'php' not in content and 'DOCTYPE' not in content
        assert 'Shown text' in content

    @pytest.mark.parametrize('tag', ['span', 'div'])
    def test_markdown_deeply_nested_page(self, tag):
        depth = 1500
        html = '<html><body>' + f'<{tag}>' * depth + 'deep' + f'</{tag}>' * depth + '</body></html>'
        assert page_to_markdown(html, 'https://x/')['content'] == 'deep'
        assert page_to_text(html)['content'] == 'deep'

    def test_links_dedup_and_absolute(self):
        links = page_links(HTML + b'<a href="/p/1">dup</a><a href="mailto:x@y">m</a>', 'https://example.com/')
        urls = [link['url'] for link in links]
        assert urls.count('https://example.com/p/1') == 1
        assert all(u.startswith('http') for u in urls)

    def test_html_to_text(self):
        assert html_to_text('<p>a&amp;b</p>  <script>x</script>') == 'a&b'
        assert html_to_text('plain   text') == 'plain text'
        assert html_to_text(None) == ''


class TestDeclaredCharset:
    # 'Ã©' in windows-1252 is the same two bytes as 'é' in UTF-8.
    PAGE = '<html><body><main><p class="r"><a href="/x">Ã©</a></p></main></body></html>'.encode('cp1252')

    def test_the_declared_charset_decides_how_a_page_decodes(self):
        assert page_to_text(self.PAGE, encoding='windows-1252')['content'] == 'Ã©'
        markdown = page_to_markdown(self.PAGE, 'https://e.com/', encoding='windows-1252')['content']
        assert markdown == '[Ã©](https://e.com/x)'
        assert page_links(self.PAGE, 'https://e.com/', encoding='windows-1252')[0]['text'] == 'Ã©'
        items = extract_html_items(self.PAGE, 'https://e.com/', '.r', {'title': ''}, encoding='windows-1252')
        assert items == [{'title': 'Ã©'}]

    @pytest.mark.parametrize('encoding', [None, 'x-no-such-codec', 'base64'])
    def test_without_a_usable_declared_charset_the_document_decides(self, encoding):
        assert page_to_text(self.PAGE, encoding=encoding)['content'] == 'é'

    def test_a_byte_order_mark_outranks_the_declared_charset(self):
        page = codecs.BOM_UTF8 + '<p>é</p>'.encode('utf-8')
        assert page_to_text(page, encoding='windows-1252')['content'] == 'é'

    def test_latin1_labels_decode_as_windows_1252(self):
        page = '<p>“quoted”</p>'.encode('cp1252')
        assert page_to_text(page, encoding='iso-8859-1')['content'] == '“quoted”'
