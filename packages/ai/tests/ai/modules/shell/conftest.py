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

"""Shared isolation for the shell module tests."""

import pytest


@pytest.fixture(autouse=True)
def _public_pages_state(monkeypatch):
    """Every test starts on a fresh page map and an empty store.

    The fresh ``PageMap`` holds the legacy aggregate, runs no rebuild and has
    its own rebuild lock (a lock binds to the event loop that first waits on
    it). ``_built_at = inf`` keeps the refresh backstop from scheduling a
    rebuild against the real account singleton. No web server is wired, so no
    live route check is installed. The render caches start empty and are
    dropped on every swap, as after startup; swap listeners a test adds are
    dropped with the page map. The artifact store is the hostile fixture's
    in-memory ``FILES`` (empty unless a test seeds it), so unit tests never
    touch a real store. The render and snapshot caches and the
    unusable-snapshot memory start empty, with their production budgets.
    """
    import ai.modules.shell.pages as pages
    import ai.modules.shell.public_pages as pp

    from .hostile_fixtures import FILES, file_info, read_file

    fresh = pp.PageMap()
    fresh._built_at = float('inf')
    monkeypatch.setattr(pp, 'page_map', fresh)
    monkeypatch.setattr(pages, '_web_server', None)
    monkeypatch.setattr(
        pages, '_render_cache', pages._FifoCache(pages._RENDER_CACHE_MAX_BYTES, pages._RENDER_CACHE_MAX)
    )
    monkeypatch.setattr(pages, '_snapshot_cache', pages._FifoCache(pages._SNAPSHOT_CACHE_MAX_BYTES))
    monkeypatch.setattr(
        pages, '_unusable_snapshots', pages._FifoCache(pages._UNUSABLE_SNAPSHOTS_MAX, pages._UNUSABLE_SNAPSHOTS_MAX)
    )
    monkeypatch.setattr(pages, '_documents', {})
    pp.on_swap(pages._clear_rendered)  # as register_public_pages installs it
    FILES.clear()
    monkeypatch.setattr(pp, 'read_artifact_file', read_file)
    monkeypatch.setattr(pp, 'artifact_file_info', file_info)
