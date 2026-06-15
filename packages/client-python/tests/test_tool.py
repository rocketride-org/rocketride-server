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

"""
Integration tests for ``client.tool()`` and ``DataPipe.tool()``.

Starts a pipeline with a tool_python node and invokes its ``execute`` tool
via the new DAP ``tool`` subcommand -- both standalone (borrowed pipe) and
pipe-bound paths.
"""

import pytest
import pytest_asyncio

from rocketride import RocketRideClient
from conftest import ensure_clean_pipeline
from tool_pipeline import get_tool_pipeline


# =========================================================================
# FIXTURES
# =========================================================================

TOOL_TOKEN = 'PY-TOOL'


@pytest_asyncio.fixture
async def tool_pipeline(client: RocketRideClient):
    """Start a tool_python pipeline, yield its token, terminate on teardown."""
    await ensure_clean_pipeline(client, TOOL_TOKEN)

    result = await client.use(pipeline=get_tool_pipeline(), token=TOOL_TOKEN)
    pipeline_token = result['token']
    try:
        yield pipeline_token
    finally:
        await ensure_clean_pipeline(client, pipeline_token)


# =========================================================================
# STANDALONE client.tool() -- borrows a pipe from the pool
# =========================================================================


class TestStandaloneTool:
    """Tests for client.tool() which borrows a pipe for each call."""

    @pytest.mark.asyncio
    async def test_executes_python_and_returns_result(self, client: RocketRideClient, tool_pipeline: str):
        """client.tool() invokes execute on tool_python_1 and returns the result dict."""
        result = await client.tool(
            token=tool_pipeline,
            tool='execute',
            node_id='tool_python_1',
            input={'code': 'result = {"answer": 2 + 2}'},
        )

        assert result is not None
        assert isinstance(result, dict)
        assert result.get('exit_code') == 0
        assert result.get('result') == {'answer': 4}

    @pytest.mark.asyncio
    async def test_stdout_capture(self, client: RocketRideClient, tool_pipeline: str):
        """client.tool() captures stdout from the sandboxed script."""
        result = await client.tool(
            token=tool_pipeline,
            tool='execute',
            node_id='tool_python_1',
            input={'code': 'print("hello")'},
        )

        assert result is not None
        assert result.get('exit_code') == 0
        assert 'hello' in result.get('stdout', '')

    @pytest.mark.asyncio
    async def test_invalid_tool_name_raises(self, client: RocketRideClient, tool_pipeline: str):
        """client.tool() raises when the node doesn't own the tool."""
        with pytest.raises(RuntimeError):
            await client.tool(
                token=tool_pipeline,
                tool='nonexistent_tool',
                node_id='tool_python_1',
                input={},
            )


# =========================================================================
# PIPE-BOUND DataPipe.tool() -- reuses an already-open pipe
# =========================================================================


class TestPipeBoundTool:
    """Tests for DataPipe.tool() which reuses the caller's open pipe."""

    @pytest.mark.asyncio
    async def test_executes_python_through_open_pipe(self, client: RocketRideClient, tool_pipeline: str):
        """DataPipe.tool() invokes a tool using the pipe's pipeline instance."""
        pipe = await client.pipe(tool_pipeline, {}, 'text/plain')
        await pipe.open()

        try:
            result = await pipe.tool(
                tool='execute',
                node_id='tool_python_1',
                input={'code': 'result = list(range(5))'},
            )

            assert result is not None
            assert result.get('exit_code') == 0
            assert result.get('result') == [0, 1, 2, 3, 4]
        finally:
            await pipe.close()

    @pytest.mark.asyncio
    async def test_before_open_raises(self, client: RocketRideClient, tool_pipeline: str):
        """DataPipe.tool() raises RuntimeError if the pipe is not open."""
        pipe = await client.pipe(tool_pipeline, {}, 'text/plain')

        with pytest.raises(RuntimeError, match='not open'):
            await pipe.tool(tool='execute', node_id='tool_python_1', input={'code': 'pass'})
