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
# =============================================================================
"""The interface map of a pipeline spec (plan 3.6): sources under their own
address, every other node under the pipe address, one entry per catalog
classType, ``name`` always present, no reachability, no engine. And what
each source is (``pipe_sources``): its kind, entry, title and lanes, from its
provider's declaration, under the same address.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

import pytest

from ai.modules.task.interfaces import pipe_interfaces, pipe_sources

# ==== Fixtures =================================================================

CATALOG: Dict[str, Dict[str, Any]] = {
    'chat': {
        'title': 'Chat',
        'classType': ['source', 'chat'],
        'sourceKind': 'request',
        'lanes': {'_source': ['questions']},
    },
    'tools': {
        'title': 'Tools',
        'classType': ['source', 'tools'],
        'sourceKind': 'request',
        'invoke': {'tool': {'min': 0}},
        'lanes': {'_source': []},
    },
    'telegram': {
        'title': 'Telegram Bot',
        'classType': ['source'],
        'sourceKind': 'listener',
        'lanes': {'_source': ['text', 'image', 'tags']},
    },
    'filesys': {'title': 'Local File System', 'classType': ['source'], 'lanes': {'_source': ['tags']}},
    'odd_kind': {'title': 'Odd', 'classType': ['source'], 'sourceKind': 'remote'},
    'tool_pipe': {
        'title': 'Pipeline Tool',
        'classType': ['tool'],
        'sourceKind': 'request',
        'lanes': {'_source': ['text', 'questions']},
    },
    'llm_agent': {'classType': ['llm', 'agent']},
    'db_postgres': {'classType': ['database', 'tool']},
    'db_mysql': {'classType': ['database', 'tool']},
    'extract_data': {'classType': ['tool']},
    'legacy_source': {'classType': 'source'},
}


async def lookup(provider: str) -> Optional[Dict[str, Any]]:
    """The fake catalog: the entry, or None for an unknown node."""
    return CATALOG.get(provider)


def _pipeline() -> Dict[str, Any]:
    """Two sources: chat → agent → two databases; tools → extract."""
    return {
        'project_id': 'docBrain',
        'source': 'chat',
        'components': [
            {'id': 'chat', 'provider': 'chat', 'name': 'My Chat Box', 'config': {'mode': 'Source'}},
            {'id': 'agent', 'provider': 'llm_agent', 'input': [{'lane': 'questions', 'from': 'chat'}]},
            {'id': 'db_main', 'provider': 'db_postgres', 'name': 'Ops DB'},
            {'id': 'mysql_1', 'provider': 'db_mysql'},
            {'id': 'tools', 'provider': 'tools', 'config': {'mode': 'Source'}},
            {'id': 'parse', 'provider': 'extract_data'},
        ],
    }


# ==== Tests ====================================================================


@pytest.mark.asyncio
async def test_sources_sit_under_their_own_address_and_nodes_under_the_pipe_address():
    interfaces = await pipe_interfaces(_pipeline(), 'acme', 'docBrain', lookup)

    assert set(interfaces) == {'acme.docBrain.chat', 'acme.docBrain.tools', 'acme.docBrain'}
    assert interfaces['acme.docBrain.chat'] == {
        'source': [{'nodeId': 'chat', 'name': 'My Chat Box'}],
        'chat': [{'nodeId': 'chat', 'name': 'My Chat Box'}],
    }
    assert interfaces['acme.docBrain.tools']['tools'] == [{'nodeId': 'tools', 'name': 'tools'}]
    assert interfaces['acme.docBrain']['database'] == [
        {'nodeId': 'db_main', 'name': 'Ops DB'},
        {'nodeId': 'mysql_1', 'name': 'mysql_1'},
    ]


@pytest.mark.asyncio
async def test_a_node_contributes_one_entry_per_class_type_it_carries():
    interfaces = await pipe_interfaces(_pipeline(), 'acme', 'docBrain', lookup)
    pipe = interfaces['acme.docBrain']

    # Postgres is a database AND a tool; the agent an llm AND an agent
    assert {'nodeId': 'db_main', 'name': 'Ops DB'} in pipe['database']
    assert {'nodeId': 'db_main', 'name': 'Ops DB'} in pipe['tool']
    assert pipe['llm'] == [{'nodeId': 'agent', 'name': 'agent'}]
    assert pipe['agent'] == [{'nodeId': 'agent', 'name': 'agent'}]
    # extract_data is a tool only
    assert {'nodeId': 'parse', 'name': 'parse'} in pipe['tool']
    assert 'parse' not in [entry['nodeId'] for entry in pipe['database']]


@pytest.mark.asyncio
async def test_name_is_the_display_name_else_the_node_id():
    interfaces = await pipe_interfaces(_pipeline(), 'acme', 'docBrain', lookup)
    names = {entry['nodeId']: entry['name'] for entry in interfaces['acme.docBrain']['database']}

    assert names == {'db_main': 'Ops DB', 'mysql_1': 'mysql_1'}


@pytest.mark.asyncio
async def test_a_spec_marked_source_the_catalog_does_not_know_is_still_a_source():
    pipeline = {'components': [{'id': 'mine', 'provider': 'custom_src', 'config': {'mode': 'Source'}}]}
    interfaces = await pipe_interfaces(pipeline, 'acme', 'p', lookup)

    assert interfaces == {'acme.p.mine': {'source': [{'nodeId': 'mine', 'name': 'mine'}]}}


@pytest.mark.asyncio
async def test_a_string_class_type_is_read_as_one_word():
    pipeline = {'components': [{'id': 's', 'provider': 'legacy_source'}]}
    interfaces = await pipe_interfaces(pipeline, 'acme', 'p', lookup)

    assert interfaces == {'acme.p.s': {'source': [{'nodeId': 's', 'name': 's'}]}}


@pytest.mark.asyncio
async def test_unknown_nodes_and_unaddressable_components_contribute_nothing():
    pipeline = {
        'components': [
            {'id': 'ghost', 'provider': 'no_such_node'},
            {'provider': 'db_postgres'},
            {'id': 'no_provider'},
            'not a component',
        ]
    }
    interfaces = await pipe_interfaces(pipeline, 'acme', 'p', lookup)

    assert interfaces == {}


@pytest.mark.asyncio
async def test_an_empty_spec_answers_an_empty_map():
    assert await pipe_interfaces({}, 'acme', 'p', lookup) == {}


# ==== pipe_sources ===============================================================


def _sourced(*components: Dict[str, Any]) -> Dict[str, Any]:
    """A spec of the given components, each marked a source."""
    return {'components': [{**c, 'config': {'mode': 'Source'}} for c in components]}


@pytest.mark.asyncio
async def test_sources_sit_under_the_addresses_the_interface_map_gives_them():
    interfaces = await pipe_interfaces(_pipeline(), 'acme', 'docBrain', lookup)
    sources = await pipe_sources(_pipeline(), 'acme', 'docBrain', lookup)

    assert list(sources) == ['acme.docBrain.chat', 'acme.docBrain.tools']
    assert set(sources) == {address for address, by_class in interfaces.items() if 'source' in by_class}


@pytest.mark.asyncio
async def test_a_source_is_described_by_what_its_service_declares():
    sources = await pipe_sources(_pipeline(), 'acme', 'docBrain', lookup)

    assert sources['acme.docBrain.chat'] == {
        'nodeId': 'chat',
        'name': 'My Chat Box',
        'title': 'Chat',
        'kind': 'request',
        'entry': 'data',
        'lanes': ['questions'],
    }


@pytest.mark.asyncio
async def test_services_that_share_the_source_class_type_alone_are_told_apart():
    # Telegram and the file system both carry ['source'] and nothing else
    pipeline = {'components': [{'id': 'tg', 'provider': 'telegram'}, {'id': 'fs', 'provider': 'filesys'}]}
    sources = await pipe_sources(pipeline, 'acme', 'p', lookup)

    assert sources['acme.p.tg']['kind'] == 'listener'
    assert sources['acme.p.tg']['title'] == 'Telegram Bot'
    assert sources['acme.p.tg']['lanes'] == ['text', 'image', 'tags']
    assert sources['acme.p.fs']['kind'] == 'scan'


@pytest.mark.asyncio
async def test_a_service_that_declares_no_kind_or_an_unknown_one_is_a_scan():
    pipeline = {'components': [{'id': 'fs', 'provider': 'filesys'}, {'id': 'odd', 'provider': 'odd_kind'}]}
    sources = await pipe_sources(pipeline, 'acme', 'p', lookup)

    assert sources['acme.p.fs']['kind'] == 'scan'
    assert sources['acme.p.odd']['kind'] == 'scan'
    assert sources['acme.p.odd']['lanes'] == []


@pytest.mark.asyncio
async def test_a_source_that_hosts_tools_or_is_one_is_entered_by_tool_calls():
    sources = await pipe_sources(
        _sourced({'id': 'host', 'provider': 'tools'}, {'id': 'run', 'provider': 'tool_pipe'}),
        'acme',
        'p',
        lookup,
    )

    assert sources['acme.p.host']['entry'] == 'tool'
    assert sources['acme.p.run']['entry'] == 'tool'
    assert sources['acme.p.run']['kind'] == 'request'
    assert sources['acme.p.run']['lanes'] == ['text', 'questions']


@pytest.mark.asyncio
async def test_a_source_the_catalog_does_not_know_is_a_scan_titled_by_its_name():
    pipeline = _sourced({'id': 'mine', 'provider': 'custom_src', 'name': 'Mine'})
    sources = await pipe_sources(pipeline, 'acme', 'p', lookup)

    assert sources == {
        'acme.p.mine': {
            'nodeId': 'mine',
            'name': 'Mine',
            'title': 'Mine',
            'kind': 'scan',
            'entry': 'data',
            'lanes': [],
        }
    }


@pytest.mark.asyncio
async def test_components_that_are_not_sources_are_not_described():
    pipeline = {
        'components': [
            {'id': 'agent', 'provider': 'llm_agent'},
            {'id': 'run', 'provider': 'tool_pipe'},
            {'id': 'ghost', 'provider': 'no_such_node'},
            {'provider': 'chat'},
            'not a component',
        ]
    }

    assert await pipe_sources(pipeline, 'acme', 'p', lookup) == {}
    assert await pipe_sources({}, 'acme', 'p', lookup) == {}
