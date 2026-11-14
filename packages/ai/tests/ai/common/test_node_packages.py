# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A .rrnode unpacks into a nodes/ folder whole, once per digest, and never over a node the server carries."""

import hashlib
import io
import os
import time
import zipfile

import pytest

from ai.common import node_packages
from ai.common.node_packages import NodePackageInvalid


def _files(value=42):
    return {'__init__.py': f'VALUE = {value}\n'.encode(), 'services.json': b'{"protocol": "railnode://"}'}


def _package(name='railnode', value=42, extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as package:
        for path, data in _files(value).items():
            package.writestr(f'{name}/{path}', data)
        if extra:
            package.writestr(extra, '')
    return buffer.getvalue(), node_packages.content_digest(_files(value))


def _read(path):
    with open(path) as f:
        return f.read()


@pytest.fixture
def nodes(tmp_path):
    path = tmp_path / 'server' / 'nodes'
    path.mkdir(parents=True)
    return str(path)


def test_a_package_unpacks_into_nodes_with_its_digest(nodes):
    data, sha256 = _package()

    node_dir = node_packages.unpack('railnode', data, sha256, nodes)

    assert node_dir == os.path.join(nodes, 'railnode')
    assert _read(os.path.join(node_dir, '__init__.py')) == 'VALUE = 42\n'
    assert node_packages.digest_of(node_dir) == sha256
    # Nothing is left beside nodes/, and nodes/ holds only the node
    assert os.listdir(os.path.dirname(nodes)) == ['nodes']
    assert os.listdir(nodes) == ['railnode']


def test_the_same_digest_is_not_unpacked_again(nodes):
    data, sha256 = _package()
    node_packages.unpack('railnode', data, sha256, nodes)

    node_packages.unpack('railnode', b'not read again', sha256, nodes)

    assert _read(os.path.join(nodes, 'railnode', '__init__.py')) == 'VALUE = 42\n'


def test_another_digest_replaces_the_copy_a_package_left(nodes):
    old, old_sha = _package(value=1)
    new, new_sha = _package(value=2)
    node_packages.unpack('railnode', old, old_sha, nodes)

    node_packages.unpack('railnode', new, new_sha, nodes)

    assert _read(os.path.join(nodes, 'railnode', '__init__.py')) == 'VALUE = 2\n'
    assert node_packages.digest_of(os.path.join(nodes, 'railnode')) == new_sha
    assert os.listdir(os.path.dirname(nodes)) == ['nodes']


def test_a_node_the_server_carries_is_never_replaced(nodes):
    os.makedirs(os.path.join(nodes, 'railnode'))
    with open(os.path.join(nodes, 'railnode', '__init__.py'), 'w') as f:
        f.write('VALUE = "server"')
    data, sha256 = _package()

    node_packages.unpack('railnode', data, sha256, nodes)

    assert _read(os.path.join(nodes, 'railnode', '__init__.py')) == 'VALUE = "server"'


def test_a_package_that_does_not_match_its_digest_is_refused(nodes):
    data, _ = _package()

    with pytest.raises(NodePackageInvalid):
        node_packages.unpack('railnode', data, '0' * 64, nodes)

    assert not os.path.exists(os.path.join(nodes, 'railnode'))


def test_the_digest_is_each_path_with_the_sha256_of_its_file_in_order():
    files = {'b.py': b'b', 'a/c.json': b'c'}
    lines = ''.join(f'{path}\0{hashlib.sha256(files[path]).hexdigest()}\n' for path in ('a/c.json', 'b.py'))

    assert node_packages.content_digest(files) == hashlib.sha256(lines.encode()).hexdigest()


def test_the_same_files_in_another_zip_match_the_digest(nodes):
    _, sha256 = _package()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_STORED) as package:
        for path, data in reversed(list(_files().items())):
            package.writestr(f'railnode/{path}', data)

    node_dir = node_packages.unpack('railnode', buffer.getvalue(), sha256, nodes)

    assert node_packages.digest_of(node_dir) == sha256


def test_bytes_that_are_not_a_zip_are_refused(nodes):
    with pytest.raises(NodePackageInvalid):
        node_packages.unpack('railnode', b'not a zip', node_packages.content_digest(_files()), nodes)

    assert not os.path.exists(os.path.join(nodes, 'railnode'))


def test_a_packed_node_unpacks_into_the_same_files(nodes):
    data = node_packages.pack('railnode', _files())

    node_dir = node_packages.unpack('railnode', data, node_packages.content_digest(_files()), nodes)

    assert _read(os.path.join(node_dir, '__init__.py')) == 'VALUE = 42\n'
    assert _read(os.path.join(node_dir, 'services.json')) == '{"protocol": "railnode://"}'


def test_a_package_with_files_outside_its_node_is_refused(nodes):
    data, sha256 = _package(extra='other/__init__.py')

    with pytest.raises(NodePackageInvalid):
        node_packages.unpack('railnode', data, sha256, nodes)

    assert not os.path.exists(os.path.join(nodes, 'railnode'))
    assert not os.path.exists(os.path.join(nodes, 'other'))
    assert os.listdir(os.path.dirname(nodes)) == ['nodes']


def test_an_unpack_that_was_killed_is_swept_once_it_is_old(nodes):
    parent = os.path.dirname(nodes)
    old = os.path.join(parent, '.rrnode-staging-old')
    fresh = os.path.join(parent, '.rrnode-staging-fresh')
    os.makedirs(old)
    os.makedirs(fresh)
    hour_ago = time.time() - 3700
    os.utime(old, (hour_ago, hour_ago))
    data, sha256 = _package()

    node_packages.unpack('railnode', data, sha256, nodes)

    assert not os.path.exists(old) and os.path.exists(fresh)
