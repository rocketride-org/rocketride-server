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


def _package(name='railnode', value=42, extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as package:
        package.writestr(f'{name}/__init__.py', f'VALUE = {value}\n')
        package.writestr(f'{name}/services.json', '{"protocol": "railnode://"}')
        if extra:
            package.writestr(extra, '')
    data = buffer.getvalue()
    return data, hashlib.sha256(data).hexdigest()


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
