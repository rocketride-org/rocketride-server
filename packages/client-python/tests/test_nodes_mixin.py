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


"""The Python SDK's node control surface.

Wire-shape tests: what the server does with these is pinned by the engine
suite, and what can drift here is the argument names and the unwrapping.
"""

from typing import Any, Dict

import pytest

from rocketride.mixins.nodes import NodesMixin


class _Recorder(NodesMixin):
    """A NodesMixin whose transport records instead of connecting."""

    def __init__(self, reply: Any = None):
        self.sent: list[Dict[str, Any]] = []
        self._reply = reply if reply is not None else {}

    async def call(self, command: str, **args: Any) -> Any:
        self.sent.append({'command': command, **args})
        return self._reply


class TestControl:
    """Every verb lands on rrext_deploy_node with the right subcommand."""

    @pytest.mark.asyncio
    async def test_versions_unwraps_the_rail(self):
        client = _Recorder({'versions': [{'registryVersion': 3}]})
        rows = await client.node_versions('ticket_feed')
        assert client.sent[0] == {'command': 'rrext_deploy_node', 'subcommand': 'versions', 'nodeId': 'ticket_feed'}
        assert rows == [{'registryVersion': 3}]

    @pytest.mark.asyncio
    async def test_a_node_with_no_versions_is_an_empty_list(self):
        # Not None: callers iterate this without checking.
        assert await _Recorder({}).node_versions('ticket_feed') == []

    @pytest.mark.asyncio
    async def test_deploy_pins_a_registry_version(self):
        client = _Recorder()
        await client.deploy_node('ticket_feed', 3, '@team/Platform')
        assert client.sent[0] == {
            'command': 'rrext_deploy_node',
            'subcommand': 'deploy',
            'nodeId': 'ticket_feed',
            'version': 3,
            'target': '@team/Platform',
        }

    @pytest.mark.asyncio
    async def test_deploy_defaults_to_the_caller(self):
        client = _Recorder()
        await client.deploy_node('ticket_feed', 1)
        assert client.sent[0]['target'] == '@me'

    @pytest.mark.asyncio
    async def test_where_unwraps_the_pins(self):
        client = _Recorder({'pins': [{'audience': {'type': 'user'}, 'version': 3}]})
        pins = await client.where_node('ticket_feed')
        assert client.sent[0]['subcommand'] == 'where'
        assert pins[0]['version'] == 3

    @pytest.mark.asyncio
    async def test_disable_is_reversible_and_targeted(self):
        client = _Recorder()
        await client.disable_node('ticket_feed', '@team/Platform')
        assert client.sent[0]['subcommand'] == 'disable'
        assert client.sent[0]['target'] == '@team/Platform'

    @pytest.mark.asyncio
    async def test_remove_takes_the_row_out(self):
        client = _Recorder()
        await client.remove_node('ticket_feed')
        assert client.sent[0]['subcommand'] == 'remove'

    @pytest.mark.asyncio
    async def test_withdrawing_everywhere_is_one_call(self):
        # The alternative is `where` followed by one call per audience, which
        # is neither atomic nor pleasant from a UI.
        client = _Recorder()
        await client.remove_node('ticket_feed', '@all')
        assert client.sent[0]['target'] == '@all'
        assert len(client.sent) == 1
