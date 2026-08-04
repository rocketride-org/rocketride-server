# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for Azure Boards work-item conversion (no network).

converter.py has no rocketlib/engine dependency, but importing it through the
`nodes.azure_boards` package still triggers that package's __init__, which
pulls in the engine runtime (rocketlib, depends) via IEndpoint.py. Stub those
two only (bs4/requests are real, installed packages, left untouched),
following the same import-then-restore approach used by nodes/test/confluence.
"""

from __future__ import annotations

import importlib
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

try:
    import bs4  # noqa: F401

    _HAS_BS4 = True
except ImportError:
    _HAS_BS4 = False

# _strip_html imports bs4 lazily and only when the description is non-empty —
# so tests with no description keep running regardless, and only the tests
# that push real HTML through the parser need to skip.
requires_bs4 = pytest.mark.skipif(not _HAS_BS4, reason='bs4 not installed')

_NODES_SRC = Path(__file__).resolve().parents[2] / 'src'
if str(_NODES_SRC) not in sys.path:
    sys.path.insert(0, str(_NODES_SRC))


def _build_import_stubs():
    rocketlib = MagicMock()
    rocketlib.IEndpointBase = object
    rocketlib.IGlobalBase = object
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.getObject = MagicMock()
    rocketlib.monitorStatus = lambda *a, **kw: None
    rocketlib.monitorCompleted = lambda *a, **kw: None
    rocketlib.monitorFailed = lambda *a, **kw: None

    depends = MagicMock()
    depends.depends = lambda *a, **kw: None

    ai_common_schema = MagicMock()
    ai_common_schema.Doc = MagicMock()
    ai_common_schema.DocMetadata = MagicMock()

    return {
        'rocketlib': rocketlib,
        'depends': depends,
        'ai': MagicMock(),
        'ai.common': MagicMock(),
        'ai.common.schema': ai_common_schema,
    }


_added_stubs = []
for _name, _stub in _build_import_stubs().items():
    if _name not in sys.modules:
        sys.modules[_name] = _stub
        _added_stubs.append(_name)

try:
    converter = importlib.import_module('nodes.azure_boards.converter')
finally:
    for _name in _added_stubs:
        sys.modules.pop(_name, None)


def _work_item(**fields):
    return {'id': 42, 'fields': fields}


def test_minimal_work_item_with_no_description():
    work_item = _work_item(**{'System.Title': 'Fix login bug', 'System.WorkItemType': 'Bug', 'System.State': 'Active'})

    page_content, extras = converter.build_doc_fields(work_item)

    assert 'Title: Fix login bug' in page_content
    assert 'Type: Bug' in page_content
    assert 'State: Active' in page_content
    assert extras['workItemId'] == 42
    assert extras['workItemType'] == 'Bug'
    assert extras['state'] == 'Active'
    assert extras['assignedTo'] == ''
    assert extras['tags'] == []


def test_assigned_to_as_identity_object():
    work_item = _work_item(**{'System.AssignedTo': {'displayName': 'Priya Nair', 'uniqueName': 'priya@x.com'}})

    _, extras = converter.build_doc_fields(work_item)

    assert extras['assignedTo'] == 'Priya Nair'


def test_assigned_to_as_bare_string():
    work_item = _work_item(**{'System.AssignedTo': 'Alex Chen'})

    _, extras = converter.build_doc_fields(work_item)

    assert extras['assignedTo'] == 'Alex Chen'


def test_tags_split_on_semicolon():
    work_item = _work_item(**{'System.Tags': 'backend; urgent ; needs-review'})

    _, extras = converter.build_doc_fields(work_item)

    assert extras['tags'] == ['backend', 'urgent', 'needs-review']


def test_empty_tags_field():
    work_item = _work_item(**{'System.Tags': ''})

    _, extras = converter.build_doc_fields(work_item)

    assert extras['tags'] == []


@requires_bs4
def test_description_html_is_stripped_to_plain_text():
    work_item = _work_item(
        **{'System.Description': '<div><p>Steps to reproduce:</p><ul><li>Click login</li></ul></div>'}
    )

    page_content, _ = converter.build_doc_fields(work_item)

    assert 'Steps to reproduce:' in page_content
    assert 'Click login' in page_content
    assert '<p>' not in page_content
    assert '<li>' not in page_content


@requires_bs4
def test_full_work_item_assembles_all_fields_in_order():
    work_item = _work_item(
        **{
            'System.Title': 'Add dark mode',
            'System.WorkItemType': 'Feature',
            'System.State': 'New',
            'System.AssignedTo': {'displayName': 'Jordan Blake'},
            'System.IterationPath': 'Sprint 12',
            'System.Tags': 'ui; enhancement',
            'System.Description': '<p>Users have asked for a dark theme.</p>',
        }
    )

    page_content, extras = converter.build_doc_fields(work_item)

    lines = page_content.splitlines()
    assert lines[0] == 'Title: Add dark mode'
    assert lines[1] == 'Type: Feature'
    assert lines[2] == 'State: New'
    assert 'Assigned to: Jordan Blake' in page_content
    assert 'Iteration: Sprint 12' in page_content
    assert 'Tags: ui, enhancement' in page_content
    assert 'Users have asked for a dark theme.' in page_content
    assert extras == {
        'workItemId': 42,
        'workItemType': 'Feature',
        'state': 'New',
        'assignedTo': 'Jordan Blake',
        'iterationPath': 'Sprint 12',
        'tags': ['ui', 'enhancement'],
    }
