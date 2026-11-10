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

from ai.modules.shell.head import inject_head

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


def test_the_charset_declaration_stays_within_the_first_1024_bytes():
    for charset in ('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'):
        doc = f'<!doctype html><html lang="en"><head>{charset}<title>shell</title></head><body></body></html>'
        out = inject_head(doc, title='Pricing', description='x' * 4000)
        end = out.index(charset) + len(charset)
        assert len(out[:end].encode('utf-8')) <= 1024, charset
        assert end <= out.index('<title>Pricing</title>') < out.index('</head>'), charset
