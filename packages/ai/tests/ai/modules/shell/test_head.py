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

"""Serve-time head injection."""

from __future__ import annotations

import json
import re

from ai.modules.shell.head import inject_head, jsonld_script, social_tags

DOC = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    '<title>shell</title>'
    '<meta content="old description" name="description">'
    "<meta name='robots' content='index'>"
    '<link href="https://old.example/" rel="canonical" />'
    '<meta property="og:title" content="old og">'
    '<script src="/shell/static/js/main.js"></script></head><body><div id="root"></div></body></html>'
)


def test_replaces_every_head_tag_kind_without_duplicates():
    out = inject_head(DOC, title='Pricing', description='Plans.', canonical='https://rr.example/pricing', noindex=True)
    assert out.count('<title>') == 1 and '<title>Pricing</title>' in out
    assert 'old description' not in out and 'old og' not in out and 'old.example' not in out
    assert out.count('name="description"') == 1 and 'content="Plans."' in out
    assert '<link rel="canonical" href="https://rr.example/pricing">' in out
    assert '<meta property="og:url" content="https://rr.example/pricing">' in out
    assert out.count('robots') == 1 and '<meta name="robots" content="noindex">' in out
    # The rest of the document is untouched.
    assert '<script src="/shell/static/js/main.js"></script></head><body><div id="root"></div>' in out
    assert out.index('<title>') > out.index('<head>')


def test_a_prefixed_attribute_is_not_the_attribute():
    doc = '<html><head><meta data-name="description" content="keep me"></head><body></body></html>'
    out = inject_head(doc, title='T', description='New.')
    assert '<meta data-name="description" content="keep me">' in out
    assert out.count(' name="description"') == 1


def test_a_greater_than_sign_inside_a_quoted_value_does_not_end_the_tag():
    doc = '<html><head><meta content="a>b" name="description"></head><body></body></html>'
    out = inject_head(doc, title='T', description='New.')
    assert 'a>b' not in out
    assert out.count('name="description"') == 1 and 'content="New."' in out


def test_an_attribute_inside_a_quoted_value_is_not_the_attribute():
    # og:locale: a property inject_head never replaces.
    doc = '<html><head><meta content="x name=description" property="og:locale"></head><body></body></html>'
    out = inject_head(doc, title='T', description='New.')
    assert '<meta content="x name=description" property="og:locale">' in out


def test_listed_page_has_no_robots_and_no_canonical_without_base_url():
    out = inject_head(DOC, title='T', description='', canonical='', noindex=False)
    assert 'robots' not in out and 'canonical' not in out and 'og:url' not in out
    assert 'name="description"' not in out  # empty description: no tag


def test_hostile_values_are_inert():
    hostile = '</title><script>alert(1)</script>"\'><img onerror=x>'
    out = inject_head(DOC, title=hostile, description=hostile, canonical='https://x/"><script>', noindex=False)
    assert '<script>alert' not in out and '<img' not in out
    assert out.count('</title>') == 1
    assert '&quot;&gt;&lt;script&gt;' in out


def test_documents_without_head_or_html():
    assert inject_head('<html><body>x</body></html>', title='T').startswith('<html><title>T</title>')
    assert inject_head('<p>x</p>', title='T').startswith('<title>T</title>')


def test_only_head_tags_are_replaced():
    doc = (
        '<html><head><title>old</title></head><body>'
        '<svg><title>Chart label</title></svg><script>var s = "<title>x</title>";</script></body></html>'
    )
    out = inject_head(doc, title='New')
    assert '<title>New</title>' in out and '<title>old</title>' not in out
    assert '<svg><title>Chart label</title></svg>' in out and 'var s = "<title>x</title>";' in out


def test_headless_documents_only_lose_tags_before_body():
    out = inject_head('<title>old</title><body><svg><title>keep</title></svg></body>', title='New')
    assert out.count('<title>') == 2 and '<title>keep</title>' in out and 'old' not in out


def test_jsonld_cannot_break_out_of_its_script():
    payload = {'name': '</script><script>alert(1)</script>', 'd': 'a & b \u2028\u2029'}
    script = jsonld_script(payload)
    inner = re.match(r'^<script type="application/ld\+json">(.*)</script>$', script, re.S).group(1)
    assert '<' not in inner and '>' not in inner and '&' not in inner
    assert '\u2028' not in inner and '\u2029' not in inner
    assert json.loads(inner) == payload


def test_jsonld_blocks_land_in_head():
    out = inject_head(DOC, title='T', jsonld=[{'@type': 'Organization'}, {'@type': 'WebSite'}])
    head = out[: out.index('</head>')]
    assert head.count('application/ld+json') == 2


def test_the_charset_declaration_stays_within_the_first_1024_bytes():
    for charset in ('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'):
        doc = f'<!doctype html><html lang="en"><head>{charset}<title>shell</title></head><body></body></html>'
        out = inject_head(doc, title='Pricing', description='x' * 4000)
        end = out.index(charset) + len(charset)
        assert len(out[:end].encode('utf-8')) <= 1024, charset
        assert end <= out.index('<title>Pricing</title>') < out.index('</head>'), charset


def test_extra_tags_land_in_head_verbatim_after_the_metadata():
    tag = '<link rel="alternate" type="application/rss+xml" href="/blog/feed.xml">'
    out = inject_head(DOC, title='T', jsonld=[{'@type': 'WebSite'}], extra=[tag])
    head = out[: out.index('</head>')]
    assert head.count(tag) == 1
    assert head.index('<title>T</title>') < head.index('application/ld+json') < head.index(tag)


def test_social_tags_of_an_article_with_an_image():
    assert social_tags(
        site_name='RocketRide',
        image='https://rr.example/apps/rocketride.home/v3/blog/launch.png',
        published='2026-11-09',
        modified='2026-11-10T09:00:00Z',
    ) == [
        '<meta property="og:type" content="article">',
        '<meta property="og:site_name" content="RocketRide">',
        '<meta property="og:image" content="https://rr.example/apps/rocketride.home/v3/blog/launch.png">',
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta property="article:published_time" content="2026-11-09">',
        '<meta property="article:modified_time" content="2026-11-10T09:00:00Z">',
    ]


def test_social_tags_of_a_plain_page():
    assert social_tags() == [
        '<meta property="og:type" content="website">',
        '<meta name="twitter:card" content="summary">',
    ]
    # An article never modified reports its publication time as the modification time.
    assert social_tags(published='2026-11-09')[-2:] == [
        '<meta property="article:published_time" content="2026-11-09">',
        '<meta property="article:modified_time" content="2026-11-09">',
    ]


def test_social_tags_escape_their_values():
    tags = social_tags(site_name='"><script>alert(1)</script>', image='https://x.example/a.png?a=1&b="2"')
    assert '<script>' not in ''.join(tags)
    assert '<meta property="og:site_name" content="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">' in tags
    assert '<meta property="og:image" content="https://x.example/a.png?a=1&amp;b=&quot;2&quot;">' in tags


def test_social_tags_replace_the_documents_own():
    doc = DOC.replace(
        '</head>',
        '<meta property="og:type" content="website"><meta property="og:site_name" content="old">'
        '<meta property="og:image" content="https://old.example/x.png"><meta name="twitter:card" content="summary">'
        '<meta property="article:published_time" content="2001-01-01">'
        '<meta content="2001-01-02" property="article:modified_time"></head>',
    )
    tags = social_tags(site_name='RR', image='https://rr.example/x.png', published='2026-11-09')
    out = inject_head(doc, title='T', extra=tags)
    kinds = ('og:type', 'og:site_name', 'og:image', 'twitter:card', 'article:published_time', 'article:modified_time')
    for kind in kinds:
        assert out.count(f'"{kind}"') == 1, kind
    assert 'old.example' not in out and '2001-01' not in out and 'content="old"' not in out
