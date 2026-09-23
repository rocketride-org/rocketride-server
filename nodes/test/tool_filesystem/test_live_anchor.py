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

"""LIVE end-to-end test of the tool_filesystem storage anchor.

Exercises the full production chain against a running server — the path no
unit test covers end to end:

    client.use() -> task file ('identity' + 'storage' blocks, _build_task)
    -> engine subprocess -> rocketlib.getTask() (C++ binding)
    -> Store.engine_file_store() (identity + anchor, zero node plumbing)
    -> anchored FileStore writes in the REAL backing store.

Assertions prove the two properties the design promises:
  1. The subprocess tool writes land in the CALLER's own tree (the dev-run
     anchor is users/<uid>/files) — verified by reading the same path back
     through the session-side fs_* API, and vice versa.
  2. Paths are plain and relative inside the node — no scope spelling ever
     crosses the tool surface.

The pipeline uses the 'tools' endpoint: a data-less source that hosts tool
nodes on the control-plane tool channel, driven directly via client.tool()
— no agent, no LLM.

Requires a running server (skips otherwise, like every live node test).
Run: scripts/run_node_test.cmd live_anchor
"""

from __future__ import annotations

import uuid

import pytest

# Unique per-run workspace so repeated runs and parallel sessions never collide.
_RUN_ID = uuid.uuid4().hex[:8]
_WORKDIR = f'e2e_anchor_{_RUN_ID}'


# The 'tools' endpoint holds the pipeline open; the tool node attaches via
# the control-plane tool channel exactly as it would attach to an agent.
_PIPELINE = {
    'project_id': f'pr_e2e_anchor_{_RUN_ID}',
    'source': 'tools_1',
    'components': [
        {'id': 'tools_1', 'provider': 'tools', 'config': {}, 'input': []},
        {
            'id': 'toolfs_1',
            'provider': 'tool_filesystem',
            # Delete is off by default; the cleanup step needs it.
            'config': {'allowDelete': True},
            'input': [],
            'control': [{'classType': 'tool', 'from': 'tools_1'}],
        },
    ],
}


@pytest.fixture
async def tool_pipeline(client):
    """Start the webhook+tool_filesystem pipeline; yield (client, token)."""
    result = await client.use(pipeline=_PIPELINE)
    token = result.get('token')
    assert token, f'client.use returned no token: {result}'
    yield client, token
    # Terminate the task and remove the scratch dir from the user tree.
    try:
        await client.terminate(token)
    except Exception:
        pass
    try:
        await client.fs_rmdir(_WORKDIR, recursive=True)
    except Exception:
        pass


async def _tool(client, token: str, tool: str, **input_args):
    """Invoke one tool_filesystem @tool_function on the running pipeline."""
    return await client.tool(token=token, tool=tool, node_id='toolfs_1', input=input_args)


@pytest.mark.asyncio
async def test_tool_writes_land_in_the_callers_own_tree(tool_pipeline):
    """Subprocess tool write -> session fs read: ONE storage location.

    This is the anchor round-trip: the node writes a plain relative path,
    the engine context anchors it at users/<uid>/files (dev run), and the
    very same path resolves to the same bytes through the session-side
    rrext_store surface. If the identity or anchor plumbing broke anywhere
    (task file, getTask, engine_file_store), the session read 404s.
    """
    client, token = tool_pipeline
    content = f'written inside the engine subprocess ({_RUN_ID})'

    result = await _tool(client, token, 'write_file', path=f'{_WORKDIR}/from_tool.txt', content=content)
    assert result.get('bytesWritten'), f'write_file failed: {result}'

    # Session-side read of the SAME plain path — proves both identities
    # resolved to one physical location (the caller's own tree).
    assert (await client.fs_read_string(f'{_WORKDIR}/from_tool.txt')) == content

    # Clean up through the tool; deletion must be visible session-side.
    result = await _tool(client, token, 'delete_file', path=f'{_WORKDIR}/from_tool.txt')
    assert result.get('deleted'), f'delete_file failed: {result}'
    assert (await client.fs_stat(f'{_WORKDIR}/from_tool.txt')).get('exists') is False


@pytest.mark.asyncio
async def test_session_writes_visible_to_the_tool(tool_pipeline):
    """The mirror direction: session fs write -> subprocess tool read."""
    client, token = tool_pipeline
    content = f'written by the session ({_RUN_ID})'

    await client.fs_write_string(f'{_WORKDIR}/from_session.txt', content)

    result = await _tool(client, token, 'read_file', path=f'{_WORKDIR}/from_session.txt')
    assert result.get('content') == content, f'read_file mismatch: {result}'

    # Clean up through the tool; the session must see it gone.
    result = await _tool(client, token, 'delete_file', path=f'{_WORKDIR}/from_session.txt')
    assert result.get('deleted'), f'delete_file failed: {result}'
    assert (await client.fs_stat(f'{_WORKDIR}/from_session.txt')).get('exists') is False


@pytest.mark.asyncio
async def test_tool_listing_and_lifecycle(tool_pipeline):
    """list/stat/delete through the tool operate on the anchored tree."""
    client, token = tool_pipeline

    await _tool(client, token, 'create_directory', path=f'{_WORKDIR}/sub')
    await _tool(client, token, 'write_file', path=f'{_WORKDIR}/sub/x.txt', content='x')

    listing = await _tool(client, token, 'list_directory', path=f'{_WORKDIR}/sub')
    names = [e['name'] for e in listing.get('entries', [])]
    assert 'x.txt' in names, f'listing missing x.txt: {listing}'

    stat = await _tool(client, token, 'stat_file', path=f'{_WORKDIR}/sub/x.txt')
    assert stat.get('exists') and stat.get('type') == 'file', f'stat: {stat}'

    result = await _tool(client, token, 'delete_file', path=f'{_WORKDIR}/sub/x.txt')
    assert result.get('deleted'), f'delete_file failed: {result}'
    # Deletion visible session-side too.
    assert (await client.fs_stat(f'{_WORKDIR}/sub/x.txt')).get('exists') is False
