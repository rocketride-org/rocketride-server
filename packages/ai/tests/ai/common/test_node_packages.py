# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A .rrnode unpacks into a nodes/ folder whole, once per digest, and never over a node the server carries."""

import hashlib
import io
import os
import pathlib
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
    # The vector nodes/scripts/tasks.test.js checks against the build's contentDigest
    assert node_packages.content_digest(files) == 'cbd358a9e4e48458634a275f10ca7085f3576d2eba9f9a3d28f224f8d477c200'
    # Paths sort by code point: JavaScript's default sort puts the emoji first
    unicode = {'\U0001f600.txt': b'a', '\uff21.txt': b'b'}
    assert node_packages.content_digest(unicode) == '306af2aa83b510e1390ea95c959bf150bd7a6ee619097c8e84ee5e17035ad997'


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
    old = os.path.join(nodes, '.rrnode-staging-old')
    fresh = os.path.join(nodes, '.rrnode-staging-fresh')
    os.makedirs(old)
    os.makedirs(fresh)
    hour_ago = time.time() - 3700
    os.utime(old, (hour_ago, hour_ago))
    data, sha256 = _package()

    node_packages.unpack('railnode', data, sha256, nodes)

    assert not os.path.exists(old) and os.path.exists(fresh)


def _failing_replace(monkeypatch, *failing_calls, tries=1):
    """Make os.replace raise on the given calls (1-based) and pass the rest through.

    Each rename is tried ``tries`` times without a pause (one by default, so a call number names one rename).
    """
    replace = os.replace
    calls = []

    def flaky(src, dst):
        calls.append((src, dst))
        if len(calls) in failing_calls:
            raise OSError(13, 'Access is denied', dst)
        return replace(src, dst)

    monkeypatch.setattr(node_packages.os, 'replace', flaky)
    monkeypatch.setattr(node_packages, '_MOVE_TRIES', tries)
    monkeypatch.setattr(node_packages, '_MOVE_PAUSE_SECS', 0)
    return calls


def test_a_replacement_that_fails_puts_the_previous_copy_back(nodes, monkeypatch):
    old, old_sha = _package(value=1)
    new, new_sha = _package(value=2)
    node_packages.unpack('railnode', old, old_sha, nodes)
    # The first rename moves the previous copy out, the second (the new copy in) fails
    _failing_replace(monkeypatch, 2)

    with pytest.raises(OSError):
        node_packages.unpack('railnode', new, new_sha, nodes)

    assert _read(os.path.join(nodes, 'railnode', '__init__.py')) == 'VALUE = 1\n'
    assert node_packages.digest_of(os.path.join(nodes, 'railnode')) == old_sha
    assert os.listdir(nodes) == ['railnode']


def test_a_previous_copy_that_cannot_be_put_back_is_kept(nodes, monkeypatch):
    old, old_sha = _package(value=1)
    new, new_sha = _package(value=2)
    node_packages.unpack('railnode', old, old_sha, nodes)
    # The new copy cannot move in, and the previous one cannot move back
    _failing_replace(monkeypatch, 2, 3)

    with pytest.raises(OSError, match='previous copy is kept in'):
        node_packages.unpack('railnode', new, new_sha, nodes)

    assert not os.path.exists(os.path.join(nodes, 'railnode'))
    [staging] = os.listdir(nodes)
    kept = os.path.join(nodes, staging, 'replaced')
    assert _read(os.path.join(kept, '__init__.py')) == 'VALUE = 1\n'
    assert node_packages.digest_of(kept) == old_sha


def test_a_replacement_leaves_no_backup_behind(nodes):
    old, old_sha = _package(value=1)
    new, new_sha = _package(value=2)
    node_packages.unpack('railnode', old, old_sha, nodes)

    node_packages.unpack('railnode', new, new_sha, nodes)

    assert os.listdir(nodes) == ['railnode']
    assert node_packages.digest_of(os.path.join(nodes, 'railnode')) == new_sha


def test_a_rename_refused_for_a_moment_is_tried_again(nodes, monkeypatch):
    # Windows refuses the rename of a folder while a scanner still holds a file just written into it
    data, sha256 = _package()
    calls = _failing_replace(monkeypatch, 1, 2, tries=3)

    node_dir = node_packages.unpack('railnode', data, sha256, nodes)

    assert len(calls) == 3 and node_packages.digest_of(node_dir) == sha256
    assert os.listdir(nodes) == ['railnode']


def test_a_rename_that_stays_refused_fails_after_the_last_try(nodes, monkeypatch):
    data, sha256 = _package()
    calls = _failing_replace(monkeypatch, 1, 2, 3, tries=3)

    with pytest.raises(PermissionError):
        node_packages.unpack('railnode', data, sha256, nodes)

    assert len(calls) == 3 and os.listdir(nodes) == []


def test_only_a_permission_error_is_tried_again(nodes, monkeypatch):
    data, sha256 = _package()
    calls = []

    def full(src, dst):
        calls.append(dst)
        raise OSError(28, 'No space left on device', dst)

    monkeypatch.setattr(node_packages.os, 'replace', full)
    monkeypatch.setattr(node_packages, '_MOVE_TRIES', 3)
    monkeypatch.setattr(node_packages, '_MOVE_PAUSE_SECS', 0)

    with pytest.raises(OSError, match='No space left'):
        node_packages.unpack('railnode', data, sha256, nodes)

    assert len(calls) == 1


def test_a_rename_is_tried_once_except_on_windows():
    assert node_packages._MOVE_TRIES == (10 if os.name == 'nt' else 1)


def test_a_package_unpacks_when_only_nodes_is_writable(nodes, monkeypatch):
    # A read-only root with nodes/ mounted writable, as the Helm chart runs it
    mkdtemp = node_packages.tempfile.mkdtemp

    def only_in_nodes(dir=None, **kwargs):
        if os.path.abspath(dir) != os.path.abspath(nodes):
            raise OSError(30, 'Read-only file system', dir)
        return mkdtemp(dir=dir, **kwargs)

    monkeypatch.setattr(node_packages.tempfile, 'mkdtemp', only_in_nodes)
    data, sha256 = _package()

    node_dir = node_packages.unpack('railnode', data, sha256, nodes)

    assert node_packages.digest_of(node_dir) == sha256
    assert os.listdir(nodes) == ['railnode']


def test_depends_leaves_out_the_nodes_this_marks_as_unpacked():
    depends = pathlib.Path(__file__).parents[5] / 'packages/server/engine-lib/rocketlib-python/lib/depends.py'
    assert f"_UNPACKED_MARKER = '{node_packages.DIGEST_FILE}'" in depends.read_text(encoding='utf-8')
