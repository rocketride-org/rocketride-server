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

"""Unit tests for ai.account.pipe_deploy: the publish row source.

A failing store raises; a name is never reported absent because the
database was down (audit 2026-11-12).
"""

from unittest.mock import AsyncMock

import pytest

from ai.account.pipe_deploy import publish_rows


@pytest.mark.asyncio
async def test_a_failing_registry_read_raises_instead_of_reading_as_no_rows():
    """deployments_versions failing is the caller's error, not an empty row set."""
    account = AsyncMock()
    account.deployments_versions = AsyncMock(side_effect=RuntimeError('db down'))

    with pytest.raises(RuntimeError, match='db down'):
        await publish_rows(account, 'org-1', 'docBrain', ['team-1'])


@pytest.mark.asyncio
async def test_a_failing_slot_read_raises_too():
    """deployments_get / publish_get failures propagate the same way."""
    account = AsyncMock()
    account.deployments_versions = AsyncMock(return_value=[{'version': 1, 'kind': 'pipe', 'state': 'ready'}])
    account.deployments_get = AsyncMock(side_effect=RuntimeError('slot read failed'))

    with pytest.raises(RuntimeError, match='slot read failed'):
        await publish_rows(account, 'org-1', 'docBrain', ['team-1'])
