# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Live integration tests for the Azure Boards source node.

Calls the real Azure DevOps REST API v7.1 with a Personal Access Token
(Basic auth, empty username). Read-only: only GET/POST-query requests are
made (WIQL query + workitemsbatch), nothing is created, modified, or deleted.

    export AZURE_BOARDS_LIVE_TESTS=1
    export AZURE_BOARDS_ORGANIZATION=your-org
    export AZURE_BOARDS_PROJECT=your-project
    export AZURE_BOARDS_PAT='your-personal-access-token'
    pytest nodes/test/azure_boards/test_live.py -v

AZURE_BOARDS_LIVE_TESTS=1 is a deliberate second gate on top of the
connection vars, so a shell that happens to have AZURE_BOARDS_* set for an
unrelated reason doesn't silently make real API calls during a normal
pytest run.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest
import requests

_SRC_DIR = Path(__file__).resolve().parents[2] / 'src' / 'nodes' / 'azure_boards'


def _load(module_name: str, filename: str):
    """Load an azure_boards node submodule directly by file path.

    Neither azure_boards_client.py nor converter.py import rocketlib, but
    importing them through the nodes.azure_boards *package* would still
    pull in the engine (nodes/azure_boards/__init__.py imports IEndpoint.py,
    which does). Loading by path sidesteps the package entirely — no
    engine, no stubbing needed.
    """
    spec = importlib.util.spec_from_file_location(module_name, _SRC_DIR / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


client = _load('azure_boards_client_live', 'azure_boards_client.py')
converter = _load('azure_boards_converter_live', 'converter.py')

RUN_LIVE = os.getenv('AZURE_BOARDS_LIVE_TESTS') == '1'
ORGANIZATION = os.getenv('AZURE_BOARDS_ORGANIZATION', '')
PROJECT = os.getenv('AZURE_BOARDS_PROJECT', '')
PAT = os.getenv('AZURE_BOARDS_PAT', '')

DEFAULT_WIQL = (
    'SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ORDER BY [System.ChangedDate] DESC'
)

pytestmark = pytest.mark.skipif(
    not (RUN_LIVE and ORGANIZATION and PROJECT and PAT),
    reason='Set AZURE_BOARDS_LIVE_TESTS=1 plus AZURE_BOARDS_ORGANIZATION, AZURE_BOARDS_PROJECT, and AZURE_BOARDS_PAT to run',
)


def test_lists_at_least_one_work_item_from_the_project():
    session = client.build_session(PAT)
    items = []
    for item in client.iter_work_items(session, ORGANIZATION, PROJECT, DEFAULT_WIQL, max_records=5):
        items.append(item)

    assert len(items) > 0, f'project {PROJECT!r} returned no work items — check the project name and permissions'
    for item in items:
        assert 'id' in item
        assert 'fields' in item


def test_first_work_item_converts_to_non_empty_content():
    session = client.build_session(PAT)
    first_item = next(client.iter_work_items(session, ORGANIZATION, PROJECT, DEFAULT_WIQL, max_records=1))

    page_content, extras = converter.build_doc_fields(first_item)

    assert page_content, 'converter produced empty page_content from a real work item'
    assert 'workItemId' in extras


def test_max_records_caps_the_pull():
    session = client.build_session(PAT)
    items = list(client.iter_work_items(session, ORGANIZATION, PROJECT, DEFAULT_WIQL, max_records=2))

    assert len(items) <= 2


def test_bad_token_raises_http_error():
    session = client.build_session('definitely-not-a-real-token')
    with pytest.raises(requests.HTTPError):
        list(client.iter_work_items(session, ORGANIZATION, PROJECT, DEFAULT_WIQL, max_records=1))
