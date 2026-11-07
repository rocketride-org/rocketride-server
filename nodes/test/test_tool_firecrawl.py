# =============================================================================
# RocketRide Engine
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

"""Unit tests for tool_firecrawl (no network)."""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

_NODES_SRC = Path(__file__).resolve().parents[1] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _build_import_stubs():
    """Return {module_name: stub} for the deps needed only to import the module."""
    rocketlib = MagicMock()
    rocketlib.IInstanceBase = object
    rocketlib.IGlobalBase = object
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = lambda *a, **kw: None
    rocketlib.OPEN_MODE = SimpleNamespace(CONFIG=1, RUN=2)

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_utils = MagicMock()
    ai_common_utils.normalize_tool_input = lambda args, **kw: args if isinstance(args, dict) else {}

    ai_common_config = MagicMock()
    ai_common_config.Config = MagicMock()

    firecrawl = MagicMock()
    firecrawl.FirecrawlApp = MagicMock()

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.utils': ai_common_utils,
        'ai.common.config': ai_common_config,
        'firecrawl': firecrawl,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

instance_mod = importlib.import_module('nodes.tool_firecrawl.IInstance')
global_mod = importlib.import_module('nodes.tool_firecrawl.IGlobal')

for _name in _added_stubs:
    sys.modules.pop(_name, None)


def _make_instance(max_results: int = 5):
    inst = instance_mod.IInstance()
    app = MagicMock()
    inst.IGlobal = SimpleNamespace(app=app, max_results=max_results)
    return inst, app


def test_scrape_url_passes_markdown_format_and_integration():
    inst, app = _make_instance()
    app.scrape.return_value = SimpleNamespace(markdown='# Hello', html=None, metadata={'title': 'Hello'})

    res = inst.scrape_url({'url': 'https://example.com'})

    app.scrape.assert_called_once_with('https://example.com', formats=['markdown'], integration='_rocketride')
    assert res == {'success': True, 'content': '# Hello', 'metadata': {'title': 'Hello'}}


def test_scrape_url_passes_html_format_and_returns_html():
    inst, app = _make_instance()
    app.scrape.return_value = SimpleNamespace(markdown='# Hello', html='<h1>Hello</h1>', metadata={})

    res = inst.scrape_url({'url': 'https://example.com', 'format': 'html'})

    app.scrape.assert_called_once_with('https://example.com', formats=['html'], integration='_rocketride')
    assert res == {'success': True, 'content': '<h1>Hello</h1>', 'metadata': {}}


def test_scrape_url_invalid_format_defaults_to_markdown():
    inst, app = _make_instance()
    app.scrape.return_value = SimpleNamespace(markdown='# Fallback', html=None, metadata={})

    res = inst.scrape_url({'url': 'https://example.com', 'format': 'xml'})

    app.scrape.assert_called_once_with('https://example.com', formats=['markdown'], integration='_rocketride')
    assert res['content'] == '# Fallback'


def test_map_url_passes_integration():
    inst, app = _make_instance()
    app.map.return_value = SimpleNamespace(
        links=[SimpleNamespace(url='https://example.com/a'), 'https://example.com/b']
    )

    res = inst.map_url({'url': 'https://example.com'})

    app.map.assert_called_once_with('https://example.com', integration='_rocketride')
    assert res == {'success': True, 'links': ['https://example.com/a', 'https://example.com/b']}


def test_search_web_uses_configured_max_results_and_integration():
    inst, app = _make_instance(max_results=7)
    app.search.return_value = SimpleNamespace(
        web=[
            SimpleNamespace(url='https://example.com/1', title='One', description='Desc 1', markdown=None),
            {'url': 'https://example.com/2', 'title': 'Two', 'description': 'Desc 2'},
        ]
    )

    res = inst.search_web({'query': 'rocketride'})

    app.search.assert_called_once_with('rocketride', limit=7, integration='_rocketride')
    assert res == {
        'success': True,
        'results': [
            {'url': 'https://example.com/1', 'title': 'One', 'description': 'Desc 1'},
            {'url': 'https://example.com/2', 'title': 'Two', 'description': 'Desc 2'},
        ],
    }


def test_search_web_scrape_markdown_and_limit_clamping():
    inst, app = _make_instance(max_results=5)
    app.search.return_value = SimpleNamespace(
        web=[
            SimpleNamespace(
                url='https://example.com/1',
                title='One',
                description='Desc 1',
                markdown='# Page 1',
            )
        ]
    )

    res = inst.search_web({'query': 'rocketride', 'limit': 99, 'scrape_markdown': True})

    app.search.assert_called_once_with(
        'rocketride',
        limit=20,
        integration='_rocketride',
        scrape_options={'formats': ['markdown']},
    )
    assert res == {
        'success': True,
        'results': [
            {
                'url': 'https://example.com/1',
                'title': 'One',
                'description': 'Desc 1',
                'markdown': '# Page 1',
            }
        ],
    }


def test_search_web_requires_query():
    inst, _ = _make_instance()
    with pytest.raises(ValueError, match='search_web requires a `query` parameter'):
        inst.search_web({'query': '   '})


def test_search_web_rejects_non_boolean_scrape_markdown():
    inst, _ = _make_instance()
    with pytest.raises(ValueError, match='scrape_markdown must be a boolean'):
        inst.search_web({'query': 'rocketride', 'scrape_markdown': 'false'})


def test_search_web_falls_back_to_metadata_for_scraped_documents():
    inst, app = _make_instance()
    app.search.return_value = SimpleNamespace(
        web=[
            SimpleNamespace(
                url=None,
                title=None,
                description=None,
                markdown='# Doc 1',
                metadata=SimpleNamespace(
                    url='https://example.com/doc1',
                    title='Doc 1 Title',
                    description='Doc 1 Desc',
                ),
            ),
            SimpleNamespace(
                markdown='# Doc 2',
                metadata={
                    'url': 'https://example.com/doc2',
                    'title': 'Doc 2 Title',
                    'description': 'Doc 2 Desc',
                },
            ),
        ]
    )

    res = inst.search_web({'query': 'rocketride', 'scrape_markdown': True})
    assert res == {
        'success': True,
        'results': [
            {
                'url': 'https://example.com/doc1',
                'title': 'Doc 1 Title',
                'description': 'Doc 1 Desc',
                'markdown': '# Doc 1',
            },
            {
                'url': 'https://example.com/doc2',
                'title': 'Doc 2 Title',
                'description': 'Doc 2 Desc',
                'markdown': '# Doc 2',
            },
        ],
    }


def test_iglobal_clamps_max_results(monkeypatch):
    glb = global_mod.IGlobal()
    glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=2))
    glb.glb = SimpleNamespace(logicalType='tool_firecrawl', connConfig={})

    monkeypatch.setattr(global_mod, 'FirecrawlApp', lambda api_key: SimpleNamespace(api_key=api_key))
    monkeypatch.setattr(
        global_mod.Config,
        'getNodeConfig',
        lambda logical, conn: {'apikey': 'fc-test', 'maxResults': 50},
    )
    glb.beginGlobal()
    assert glb.max_results == 20

    monkeypatch.setattr(
        global_mod.Config,
        'getNodeConfig',
        lambda logical, conn: {'apikey': 'fc-test', 'maxResults': 'invalid'},
    )
    glb.beginGlobal()
    assert glb.max_results == 5
