# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Live integration tests for the Confluence source node.

Calls the real Confluence Cloud REST API v2 with an email + API token
(Basic auth). Read-only: only GET requests are made, nothing is created,
modified, or deleted in the target space.

    export CONFLUENCE_LIVE_TESTS=1
    export CONFLUENCE_BASE_URL=https://yoursite.atlassian.net/wiki
    export CONFLUENCE_EMAIL=you@yoursite.com
    export CONFLUENCE_API_TOKEN='your-api-token'
    export CONFLUENCE_SPACE_KEY='ENG'  # a space key you can read
    pytest nodes/test/confluence/test_live.py -v

CONFLUENCE_LIVE_TESTS=1 is a deliberate second gate on top of the connection
vars, so a shell that happens to have CONFLUENCE_* set for an unrelated
reason doesn't silently make real API calls during a normal pytest run.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest
import requests

_SRC_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'confluence'


def _load(module_name: str, filename: str):
    """Load a confluence node submodule directly by file path.

    Neither confluence_client.py nor converter.py import rocketlib, but
    importing them through the nodes.confluence *package* would still pull
    in the engine (nodes/confluence/__init__.py imports IEndpoint.py, which
    does). Loading by path sidesteps the package entirely — no engine, no
    stubbing needed.
    """
    spec = importlib.util.spec_from_file_location(module_name, _SRC_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = _load('confluence_client_live', 'confluence_client.py')
converter = _load('confluence_converter_live', 'converter.py')

RUN_LIVE = os.getenv('CONFLUENCE_LIVE_TESTS') == '1'
BASE_URL = os.getenv('CONFLUENCE_BASE_URL', '').rstrip('/')
EMAIL = os.getenv('CONFLUENCE_EMAIL', '')
API_TOKEN = os.getenv('CONFLUENCE_API_TOKEN', '')
SPACE_KEY = os.getenv('CONFLUENCE_SPACE_KEY', '')

pytestmark = pytest.mark.skipif(
    not (RUN_LIVE and BASE_URL and EMAIL and API_TOKEN and SPACE_KEY),
    reason='Set CONFLUENCE_LIVE_TESTS=1 plus CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, and CONFLUENCE_SPACE_KEY to run',
)


def test_lists_at_least_one_page_from_the_space():
    session = client.build_session(EMAIL, API_TOKEN)
    pages = []
    for page in client.iter_space_pages(session, BASE_URL, SPACE_KEY, limit=5):
        pages.append(page)
        if len(pages) >= 5:  # keep the live test fast on large spaces
            break

    assert len(pages) > 0, f'space {SPACE_KEY!r} returned no pages — check the space key and permissions'
    for page in pages:
        assert 'id' in page
        assert 'title' in page
        assert 'body' in page  # requested via body-format=storage


def test_first_page_body_converts_to_non_empty_text_or_tables():
    session = client.build_session(EMAIL, API_TOKEN)
    first_page = next(client.iter_space_pages(session, BASE_URL, SPACE_KEY, limit=1))

    body_html = first_page.get('body', {}).get('storage', {}).get('value', '')
    text, tables = converter.convert_storage_html(body_html)

    # A real Confluence page almost always has *some* body content; if this
    # fails, print body_html to see what storage format actually looked like.
    assert text or tables, 'converter produced neither text nor tables from a real page body'


def test_pagination_cursor_advances_across_pages():
    """Only meaningful if the space has more pages than the batch size; skips otherwise."""
    session = client.build_session(EMAIL, API_TOKEN)
    seen_ids = []
    for page in client.iter_space_pages(session, BASE_URL, SPACE_KEY, limit=1):
        seen_ids.append(page['id'])
        if len(seen_ids) >= 3:
            break

    if len(seen_ids) < 2:
        pytest.skip(f'space {SPACE_KEY!r} has fewer than 2 pages — pagination not exercised')
    assert len(seen_ids) == len(set(seen_ids)), 'pagination returned the same page twice'


def test_bad_token_raises_http_error():
    session = client.build_session(EMAIL, 'definitely-not-a-real-token')
    with pytest.raises(requests.HTTPError):
        next(client.iter_space_pages(session, BASE_URL, SPACE_KEY, limit=1))
