# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Installing a capsule lands a node under local_nodes and the engine discovers it."""

import base64
import os
import subprocess
from pathlib import Path

import pytest

from ai.account.capsule import pack_capsule
from ai.account.node_install import (
    NodeInstallError,
    install_capsule,
    list_installed,
    uninstall_node,
)
from ai.account.node_scaffold import scaffold_node

_ENGINE = Path(__file__).resolve().parents[4] / 'dist' / 'server' / 'engine'


def _capsule(name, kind='filter'):
    return pack_capsule(name, scaffold_node(name, kind=kind))


def test_install_lands_under_local_nodes(tmp_path):
    result = install_capsule(_capsule('inst_node'), node_path=str(tmp_path))
    assert result['name'] == 'inst_node'
    assert result['protocol'] == 'inst_node://'
    node_dir = tmp_path / 'local_nodes' / 'inst_node'
    assert (node_dir / 'services.json').is_file()
    assert (tmp_path / 'local_nodes' / '__init__.py').is_file()  # package marker


def test_list_and_uninstall(tmp_path):
    install_capsule(_capsule('a_node'), node_path=str(tmp_path))
    install_capsule(_capsule('b_node'), node_path=str(tmp_path))
    assert list_installed(str(tmp_path)) == ['a_node', 'b_node']
    uninstall_node('a_node', node_path=str(tmp_path))
    assert list_installed(str(tmp_path)) == ['b_node']


def test_uninstall_missing_node_errors(tmp_path):
    with pytest.raises(NodeInstallError):
        uninstall_node('never_installed', node_path=str(tmp_path))


def test_install_overwrites_cleanly_on_upgrade(tmp_path):
    install_capsule(_capsule('up_node'), node_path=str(tmp_path))
    stray = tmp_path / 'local_nodes' / 'up_node' / 'stale.py'
    stray.write_text('old', encoding='utf-8')
    install_capsule(_capsule('up_node'), node_path=str(tmp_path))  # reinstall
    assert not stray.exists()  # clean overwrite removed the stale file


def test_install_requires_a_node_path():
    # With no --node_path and none passed, install cannot pick a target.
    with pytest.raises(NodeInstallError):
        install_capsule(_capsule('x_node'), node_path=None)


def test_install_rejects_bad_name(tmp_path):
    # Craft a capsule whose manifest name is unsafe; install must refuse it.
    import io
    import json
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as zf:
        zf.writestr('capsule.json', json.dumps({'name': 'bad name'}))
    with pytest.raises(NodeInstallError):
        install_capsule(buf.getvalue(), node_path=str(tmp_path))


@pytest.mark.skipif(not _ENGINE.exists(), reason='engine binary not built')
def test_installed_capsule_is_discovered_by_the_engine(tmp_path):
    # End-to-end: scaffold -> pack -> install -> the engine loads it via --node_path.
    install_capsule(_capsule('e2e_installed'), node_path=str(tmp_path))
    out = subprocess.run(
        [
            str(_ENGINE),
            f'--node_path={tmp_path}',
            '-c',
            'from rocketlib import getServiceDefinition; '
            "d = getServiceDefinition('e2e_installed'); "
            "print('PROTOCOL=' + (d.get('protocol') if isinstance(d, dict) else str(d)))",
        ],
        capture_output=True,
        text=True,
        timeout=120,
        env={**os.environ, 'PYTHONIOENCODING': 'utf-8'},
    )
    assert 'PROTOCOL=e2e_installed://' in out.stdout, f'stdout={out.stdout!r} stderr={out.stderr!r}'


# --- store-backed install (primary path) ------------------------------------

from ai.account.node_install import (
    install_capsule_to_store,
    list_installed_in_store,
    uninstall_node_from_store,
)


class FakeStore:
    """In-memory stand-in for FileStore: write/read/list_dir/rmdir, same shapes."""

    def __init__(self):
        self.files = {}  # path -> bytes

    async def write(self, path, data):
        self.files[path] = data

    async def read(self, path):
        return self.files[path]

    async def rmdir(self, path, recursive=False):
        prefix = path.rstrip('/') + '/'
        for k in [k for k in self.files if k.startswith(prefix)]:
            del self.files[k]

    async def list_dir(self, path=''):
        prefix = (path.rstrip('/') + '/') if path else ''
        seen = {}
        for k in self.files:
            if not k.startswith(prefix):
                continue
            rest = k[len(prefix) :]
            name = rest.split('/')[0]
            seen[name] = 'dir' if '/' in rest else 'file'
        return {'entries': [{'name': n, 'type': t} for n, t in sorted(seen.items())], 'count': len(seen)}


async def test_store_install_then_list():
    fs = FakeStore()
    result = await install_capsule_to_store(fs, _capsule('store_node', kind='source'))
    assert result['name'] == 'store_node'
    assert result['protocol'] == 'store_node://'
    assert await list_installed_in_store(fs) == ['store_node']
    # Files live under local_nodes/<name>/ in the store.
    assert 'local_nodes/store_node/services.json' in fs.files


async def test_store_install_overwrites_on_upgrade():
    fs = FakeStore()
    await install_capsule_to_store(fs, _capsule('up'))
    fs.files['local_nodes/up/stale.py'] = b'old'
    await install_capsule_to_store(fs, _capsule('up'))  # reinstall
    assert 'local_nodes/up/stale.py' not in fs.files  # clean overwrite


async def test_store_uninstall():
    fs = FakeStore()
    await install_capsule_to_store(fs, _capsule('sa_node'))
    await install_capsule_to_store(fs, _capsule('sb_node'))
    await uninstall_node_from_store(fs, 'sa_node')
    assert await list_installed_in_store(fs) == ['sb_node']


async def test_store_uninstall_missing_errors():
    with pytest.raises(NodeInstallError):
        await uninstall_node_from_store(FakeStore(), 'nope')


# --- task_engine materialization (auto-load per run, no manual --node_path) ---

from ai.account import Store
from ai.modules.task import task_engine
from ai.modules.task.task_engine import Task


def _task():
    t = Task.__new__(Task)  # bypass the heavy __init__; set only what materialize touches
    t.client_id = 'tester'
    t._node_path_dir = None
    t.debug_message = lambda *a, **k: None
    return t


async def test_materialize_writes_store_nodes_and_cleans_up(monkeypatch):
    fs = FakeStore()
    await install_capsule_to_store(fs, _capsule('mat_node'))
    monkeypatch.setattr(Store, 'file_store', lambda *a, **k: fs)
    monkeypatch.setattr(task_engine, 'startup_args', lambda: [])  # no parent --node_path

    t = _task()
    node_dir = await t._materialize_installed_nodes()
    assert node_dir
    root = os.path.join(node_dir, 'local_nodes')
    assert os.path.isfile(os.path.join(root, '__init__.py'))  # importable package
    assert os.path.isfile(os.path.join(root, 'mat_node', 'services.json'))

    t._cleanup_materialized_nodes()
    assert not os.path.isdir(node_dir)
    assert t._node_path_dir is None


async def test_materialize_returns_none_when_nothing_installed(monkeypatch):
    monkeypatch.setattr(Store, 'file_store', lambda *a, **k: FakeStore())
    monkeypatch.setattr(task_engine, 'startup_args', lambda: [])
    assert await _task()._materialize_installed_nodes() is None


# --- handler verbs (no store needed) -----------------------------------------

from ai.modules.task.commands.cmd_node_dev import NodeDevCommands


def _conn():
    return NodeDevCommands.__new__(NodeDevCommands)


async def test_handler_pack_returns_base64_capsule():
    files = scaffold_node('packv', kind='filter')
    result = await _conn().on_rrext_node_dev({'arguments': {'subcommand': 'pack', 'name': 'packv', 'files': files}})
    assert result['name'] == 'packv'
    # The returned capsule decodes to a real .rrc a subsequent install accepts.
    from ai.account.capsule import read_capsule

    manifest, _ = read_capsule(base64.b64decode(result['capsule']))
    assert manifest['name'] == 'packv'
