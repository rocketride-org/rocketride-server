# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""A .rrnode unpacks once under the engine cache, by digest, and imports on demand."""

import hashlib
import importlib
import io
import os
import sys
import zipfile

import pytest

from ai.common import node_packages
from ai.common.node_packages import NodePackageInvalid

DEFINITION = {'protocol': 'railnode://', 'path': 'nodes.railnode'}


def _package(name='railnode', value=42):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as package:
        package.writestr(f'{name}/__init__.py', f'VALUE = {value}\n')
        package.writestr(f'{name}/.rrnode', '{}')
    data = buffer.getvalue()
    return data, hashlib.sha256(data).hexdigest()


@pytest.fixture
def cache(tmp_path, monkeypatch):
    calls = {'registered': [], 'asked': []}
    monkeypatch.setattr(node_packages, 'engine_cache_dir', lambda create=False: str(tmp_path))
    monkeypatch.setattr(node_packages.engLib, 'registerServices', calls['registered'].append, raising=False)
    monkeypatch.setattr(node_packages, '_source', None)
    monkeypatch.setattr(sys, 'path', list(sys.path))
    monkeypatch.setattr(sys, 'meta_path', list(sys.meta_path))
    for name in [m for m in sys.modules if m == 'nodes' or m.startswith('nodes.')]:
        monkeypatch.delitem(sys.modules, name)
    return tmp_path, calls


def _serve(calls):
    def source(name):
        calls['asked'].append(name)
        if name != 'railnode':
            return None
        data, sha256 = _package()
        return 'railnode', data, sha256, {'services.json': DEFINITION}

    node_packages.serve(source)


def test_a_package_unpacks_once_under_its_digest(cache):
    tmp, _ = cache
    data, sha256 = _package()

    first = node_packages.unpack('railnode', data, sha256)
    second = node_packages.unpack('railnode', b'not read again', sha256)

    assert first == second == os.path.join(tmp, 'node-packages', sha256, 'nodes', 'railnode')
    assert os.path.isfile(os.path.join(first, '__init__.py'))
    assert [n for n in os.listdir(tmp) if n != 'node-packages'] == []


def test_a_folder_that_only_shares_a_digest_prefix_is_not_reused(cache):
    tmp, _ = cache
    data, sha256 = _package()
    planted = os.path.join(tmp, 'node-packages', sha256[:16], 'nodes', 'railnode')
    os.makedirs(planted)
    with open(os.path.join(planted, '__init__.py'), 'w') as f:
        f.write('VALUE = "planted"')

    node_dir = node_packages.unpack('railnode', data, sha256)

    with open(os.path.join(node_dir, '__init__.py')) as f:
        assert f.read() == 'VALUE = 42\n'


def test_a_package_that_does_not_match_its_digest_is_refused(cache):
    tmp, _ = cache
    data, _ = _package()

    with pytest.raises(NodePackageInvalid) as refused:
        node_packages.unpack('railnode', data, '0' * 64)

    assert refused.value.code == 'NODE_PACKAGE_INVALID'
    assert not os.path.exists(os.path.join(tmp, 'node-packages'))


def test_another_process_unpacking_the_same_digest_first_is_kept(cache, monkeypatch):
    tmp, _ = cache
    data, sha256 = _package()
    root = os.path.join(tmp, 'node-packages', sha256)
    real_replace = os.replace

    def lose_the_race(src, dst):
        os.makedirs(os.path.join(dst, 'nodes', 'railnode'))
        real_replace(src, dst)

    monkeypatch.setattr(node_packages.os, 'replace', lose_the_race)

    assert node_packages.unpack('railnode', data, sha256) == os.path.join(root, 'nodes', 'railnode')
    assert [n for n in os.listdir(tmp) if n != 'node-packages'] == []


def test_ensure_fetches_and_registers_a_node_the_engine_does_not_know(cache, monkeypatch):
    _, calls = cache
    monkeypatch.setattr(node_packages, 'getServiceDefinition', lambda name: None)
    _serve(calls)

    node_packages.ensure('railnode')

    ((definition, path),) = calls['registered'][0]
    assert definition == DEFINITION and path.endswith(os.path.join('nodes', 'railnode', 'services.json'))


def test_ensure_leaves_a_node_the_engine_knows(cache, monkeypatch):
    _, calls = cache
    monkeypatch.setattr(node_packages, 'getServiceDefinition', lambda name: {})
    _serve(calls)

    node_packages.ensure('railnode')

    assert calls['asked'] == [] and calls['registered'] == []


def test_an_import_unpacks_the_node_without_registering_it_again(cache):
    _, calls = cache
    _serve(calls)

    assert importlib.import_module('nodes.railnode').VALUE == 42
    importlib.import_module('nodes.railnode')

    assert calls['asked'] == ['railnode'] and calls['registered'] == []


def test_a_name_that_is_no_node_is_left_to_the_usual_error(cache):
    _, calls = cache
    _serve(calls)

    with pytest.raises(ModuleNotFoundError):
        importlib.import_module('nodes.nosuchnode')
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module('railmissing.thing')

    assert calls['asked'] == ['nosuchnode']


def test_a_node_that_cannot_be_fetched_fails_the_import_as_an_import_error(cache):
    def broken(name):
        raise NodePackageInvalid('The package of railnode does not match its digest')

    node_packages.serve(broken)

    with pytest.raises(ImportError, match='does not match its digest'):
        importlib.import_module('nodes.railnode')
