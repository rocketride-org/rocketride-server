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


# --- handler verbs -----------------------------------------------------------

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


async def test_handler_install_routes_to_install(tmp_path):
    # No --node_path in the test engine's argv, so install routes through and reports it.
    files = scaffold_node('routed', kind='filter')
    blob = base64.b64encode(pack_capsule('routed', files)).decode('ascii')
    with pytest.raises(NodeInstallError):
        await _conn().on_rrext_node_dev({'arguments': {'subcommand': 'install', 'capsule': blob}})


async def test_handler_list_returns_nodes_key():
    result = await _conn().on_rrext_node_dev({'arguments': {'subcommand': 'list'}})
    assert 'nodes' in result and isinstance(result['nodes'], list)
