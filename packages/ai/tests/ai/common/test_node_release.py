# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A node's .rrnode is packed from the release's node archive in dist/nodes, and nothing is downloaded."""

import io
import json
import os
import socket
import zipfile

import pytest

from ai.common import node_packages, node_release

LLM_X = {'__init__.py': b'VALUE = 1\n', 'services.json': b'{"protocol": "llm_x://"}'}
LLM_X_BIG = {'__init__.py': b'VALUE = 2\n'}


@pytest.fixture
def layout(tmp_path, monkeypatch):
    """An engine in <tmp>/server whose index names <tmp>/nodes/nodes.zip, holding llm_x and llm_x_big."""
    monkeypatch.setattr(node_release.sys, 'executable', str(tmp_path / 'server' / 'engine'))
    os.makedirs(tmp_path / 'server' / 'nodes')
    (tmp_path / 'server' / 'nodes' / 'index.json').write_text(json.dumps({'archive': 'nodes.zip'}))
    os.makedirs(tmp_path / 'nodes')
    with zipfile.ZipFile(tmp_path / 'nodes' / 'nodes.zip', 'w') as archive:
        for name, files in (('llm_x', LLM_X), ('llm_x_big', LLM_X_BIG)):
            for path, data in files.items():
                archive.writestr(f'{name}/{path}', data)

    def offline(*args, **kwargs):
        raise AssertionError('a node package is never downloaded')

    monkeypatch.setattr(socket, 'socket', offline)
    return tmp_path


def _files(data):
    with zipfile.ZipFile(io.BytesIO(data)) as package:
        return {entry.filename: package.read(entry) for entry in package.infolist()}


def test_the_index_is_the_one_the_server_was_built_with(layout):
    assert json.loads(node_release.read_index()) == {'archive': 'nodes.zip'}


def test_a_node_is_packed_from_the_archive_with_only_its_own_files(layout):
    data = node_release.read_package('llm_x', node_packages.content_digest(LLM_X))

    assert _files(data) == {'llm_x/__init__.py': b'VALUE = 1\n', 'llm_x/services.json': b'{"protocol": "llm_x://"}'}


def test_a_packed_node_unpacks_with_the_digest_the_index_lists(layout):
    sha256 = node_packages.content_digest(LLM_X)
    data = node_release.read_package('llm_x', sha256)
    os.makedirs(layout / 'run')

    node_dir = node_packages.unpack('llm_x', data, sha256, str(layout / 'run' / 'nodes'))

    assert node_packages.digest_of(node_dir) == sha256


def test_a_node_the_archive_does_not_hold_is_not_found(layout):
    with pytest.raises(FileNotFoundError, match='llm_y is not in nodes.zip'):
        node_release.read_package('llm_y', node_packages.content_digest(LLM_X))


def test_an_index_that_names_no_archive_says_so(layout):
    (layout / 'server' / 'nodes' / 'index.json').write_text(json.dumps({'nodes': {}}))

    with pytest.raises(FileNotFoundError, match='The node index names no node archive'):
        node_release.read_package('llm_x', node_packages.content_digest(LLM_X))


def test_files_that_do_not_match_the_index_are_refused(layout):
    with pytest.raises(ValueError, match='llm_x in nodes.zip does not match the index'):
        node_release.read_package('llm_x', node_packages.content_digest(LLM_X_BIG))
