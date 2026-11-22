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

"""
The engine warns at start when /task/fetch URLs are signed with a per-process key.

Only the filesystem store backend signs those URLs. RR_STORE_URL may carry
``${VAR}`` or ``%VAR%`` placeholders, so the check expands them the same way the
store does before looking at the scheme; an unresolvable value warns.
"""

from __future__ import annotations

import pytest

from ai.modules.task import fetch


@pytest.fixture
def warnings_seen(monkeypatch):
    """Record warning() calls and start each case with a clean environment."""
    seen = []
    monkeypatch.setattr(fetch, 'warning', seen.append)
    for name in ('RR_SIGNING_KEY', 'RR_STORE_URL', 'STORE_BACKEND', 'UNSET_VAR'):
        monkeypatch.delenv(name, raising=False)
    return seen


@pytest.mark.parametrize(
    'store_url, backend',
    [
        (None, None),
        ('', None),
        ('   ', None),
        ('filesystem:///srv/store', None),
        ('FILESYSTEM:///x', None),
        ('${STORE_BACKEND}:///srv/store', 'filesystem'),
        ('%STORE_BACKEND%:///srv', 'filesystem'),
        ('${UNSET_VAR}:///x', None),
    ],
)
def test_warns_when_store_is_filesystem_or_unknown(monkeypatch, warnings_seen, store_url, backend):
    if store_url is not None:
        monkeypatch.setenv('RR_STORE_URL', store_url)
    if backend is not None:
        monkeypatch.setenv('STORE_BACKEND', backend)

    fetch.warn_if_signing_key_is_ephemeral()

    assert len(warnings_seen) == 1
    assert 'RR_SIGNING_KEY' in warnings_seen[0]


@pytest.mark.parametrize(
    'store_url, backend',
    [
        ('s3://b/p', None),
        ('azureblob://c/p', None),
        ('azure://c/p', None),
        ('S3://b', None),
        ('${STORE_BACKEND}://b', 's3'),
    ],
)
def test_silent_for_presigning_backends(monkeypatch, warnings_seen, store_url, backend):
    monkeypatch.setenv('RR_STORE_URL', store_url)
    if backend is not None:
        monkeypatch.setenv('STORE_BACKEND', backend)

    fetch.warn_if_signing_key_is_ephemeral()

    assert warnings_seen == []


def test_silent_when_signing_key_is_set(monkeypatch, warnings_seen):
    monkeypatch.setenv('RR_SIGNING_KEY', 'k' * 32)
    monkeypatch.setenv('RR_STORE_URL', 'filesystem:///srv/store')

    fetch.warn_if_signing_key_is_ephemeral()

    assert warnings_seen == []
