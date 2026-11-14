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

"""``open`` is idempotent on the server-minted ``correlationId`` (ALB seam 7, plan 3.1)."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.data.data_conn import DataConn, DataConnPipe


@pytest.mark.asyncio
async def test_a_second_open_for_one_correlation_id_returns_the_same_binding():
    """No second pipe is taken: the open binding's slot and traceId come back."""
    conn = DataConn(server=MagicMock(), transport=MagicMock())
    try:
        conn._pipe_map[3] = DataConnPipe(pipe_id=3, is_open=True, trace_id=0x2A0001, correlation_id='req-1')
        conn._open_by_correlation['req-1'] = 3
        conn._ensure_pipe_sem = AsyncMock(side_effect=AssertionError('a second pipe was requested'))
        request = {'command': 'rrext_process', 'seq': 7, 'arguments': {}}

        response = await conn._open(
            request, {'object': {'name': 'x'}, 'mimeType': 'text/plain', 'correlationId': 'req-1'}
        )

        assert response['body'] == {'pipe_id': 3, 'traceId': 0x2A0001}
        conn._ensure_pipe_sem.assert_not_awaited()
    finally:
        await conn.disconnect()


@pytest.mark.asyncio
async def test_another_correlation_id_takes_its_own_pipe():
    """A different request id never matches an open binding."""
    conn = DataConn(server=MagicMock(), transport=MagicMock())
    try:
        conn._pipe_map[3] = DataConnPipe(pipe_id=3, is_open=True, trace_id=1, correlation_id='req-1')
        conn._open_by_correlation['req-1'] = 3
        conn._ensure_pipe_sem = AsyncMock(side_effect=RuntimeError('took the pipe path'))

        with pytest.raises(RuntimeError, match='took the pipe path'):
            await conn._open(
                {'command': 'rrext_process', 'seq': 8, 'arguments': {}},
                {'object': {'name': 'x'}, 'mimeType': 'text/plain', 'correlationId': 'req-2'},
            )
    finally:
        await conn.disconnect()
