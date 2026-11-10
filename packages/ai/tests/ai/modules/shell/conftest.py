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
    """Every test starts on the legacy aggregate, with no background rebuilds and an empty store.

    Tests that exercise rebuilds drive them explicitly, each on a fresh
    rebuild lock (a lock binds to the event loop that first waits on it).
    Swap listeners a test adds are dropped with it. The artifact store is the
    hostile fixture's in-memory ``FILES`` (empty unless a test seeds it), so
    unit tests never touch a real store.
    """
    import asyncio

    import ai.modules.shell.public_pages as pp

    from .hostile_fixtures import FILES, file_info, read_file

    monkeypatch.setattr(pp, '_current', None)
    monkeypatch.setattr(pp, '_live_conflict', None)
    monkeypatch.setattr(pp, '_on_swap', list(pp._on_swap))
    monkeypatch.setattr(pp, '_rebuild_lock', asyncio.Lock())
    monkeypatch.setattr(pp, '_rebuild_task', None)
    monkeypatch.setattr(pp, '_rebuild_pending', False)
    FILES.clear()
    monkeypatch.setattr(pp, 'read_artifact_file', read_file)
    monkeypatch.setattr(pp, 'artifact_file_info', file_info)
