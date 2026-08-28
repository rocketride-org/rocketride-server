# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Install a node capsule into the engine's ``local_nodes`` so it loads live.

Installing writes the capsule payload under ``<node_path>/local_nodes/<name>/`` — the
exact layout the engine discovers via ``--node_path`` (see node_scaffold.py) — and
makes sure ``local_nodes`` is an importable package. The install target is the active
``--node_path``, so the same code works in OSS (a VSCode workspace) and in the cloud
(the engine started against a per-user node path); no store coupling.

This is engine-side, so every surface installs the same way: the VSCode extension,
the web builder and Claude all send a capsule to ``rrext_node_dev`` install and land
here. The safety airlock is deferred to the marketplace (see capsule.py).
"""

import os
import shutil
from typing import Dict, List, Optional

from rocketlib import args as startup_args

from ai.account.capsule import NODES_ROOT, read_capsule
from ai.account.node_scaffold import _NAME_RE


class NodeInstallError(Exception):
    """Install/uninstall could not proceed (no node path, bad name, missing node)."""


def resolve_node_path() -> Optional[str]:
    """The active ``--node_path`` the engine was started with, or None if unset."""
    for arg in startup_args():
        if arg.startswith('--node_path='):
            return arg[len('--node_path=') :]
    return None


def _local_nodes_dir(node_path: Optional[str]) -> str:
    node_path = node_path or resolve_node_path()
    if not node_path:
        raise NodeInstallError('no --node_path configured; cannot install custom nodes')
    return os.path.join(node_path, NODES_ROOT)


def _ensure_package(local_nodes: str) -> None:
    """Make ``local_nodes`` an importable package so the engine can import its nodes."""
    os.makedirs(local_nodes, exist_ok=True)
    init = os.path.join(local_nodes, '__init__.py')
    if not os.path.exists(init):
        open(init, 'w', encoding='utf-8').close()


def _safe_name(name: Optional[str]) -> str:
    if not _NAME_RE.match(name or ''):
        raise NodeInstallError(f'invalid node name {name!r}')
    return name


def install_capsule(zip_bytes: bytes, node_path: Optional[str] = None) -> Dict[str, object]:
    """Install a ``.rrc`` capsule; overwrites an existing node of the same name (upgrade).

    Args:
        zip_bytes: the capsule bytes.
        node_path: install target; defaults to the active ``--node_path``.

    Returns:
        ``{'name', 'protocol', 'version', 'files': [relpaths]}``.
    """
    manifest, payload = read_capsule(zip_bytes)
    name = _safe_name(manifest.get('name'))
    local_nodes = _local_nodes_dir(node_path)
    _ensure_package(local_nodes)

    dest = os.path.join(local_nodes, name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)  # clean overwrite so a removed file never lingers on upgrade
    written: List[str] = []
    for rel, body in payload.items():
        target = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        # utf-8 explicitly: the engine may run in an ASCII locale and node files are utf-8.
        with open(target, 'wb') as fh:
            fh.write(body)
        written.append(rel)

    return {
        'name': name,
        'protocol': manifest.get('protocol') or f'{name}://',
        'version': manifest.get('version'),
        'files': sorted(written),
    }


def uninstall_node(name: str, node_path: Optional[str] = None) -> Dict[str, object]:
    """Remove an installed node folder. Errors if it is not installed."""
    name = _safe_name(name)
    dest = os.path.join(_local_nodes_dir(node_path), name)
    if not os.path.isdir(dest):
        raise NodeInstallError(f'node {name!r} is not installed')
    shutil.rmtree(dest)
    return {'name': name, 'removed': True}


def list_installed(node_path: Optional[str] = None) -> List[str]:
    """Names of the currently installed custom nodes (empty if none / no node path)."""
    try:
        local_nodes = _local_nodes_dir(node_path)
    except NodeInstallError:
        return []
    if not os.path.isdir(local_nodes):
        return []
    return sorted(
        d for d in os.listdir(local_nodes) if d != '__pycache__' and os.path.isdir(os.path.join(local_nodes, d))
    )
