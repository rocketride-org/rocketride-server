# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""NodeDevCommands: DAP router for the Node Builder (``rrext_node_dev``).

The Node Builder authors custom nodes. Its logic lives in the engine so every
surface — the VSCode extension and the web builder — drives it through the same
``client.call('rrext_node_dev', ...)`` and gets identical output.

Subcommands:
  - ``scaffold`` — render a new node folder as a ``{path: contents}`` file map.
  - ``validate`` — check a node folder before it is tested or deployed.
  - ``pack``     — build a ``.rrc`` capsule (base64) from a node file map.
  - ``install``  — install a ``.rrc`` (base64) into the engine's ``local_nodes``.
  - ``uninstall``— remove an installed custom node.
  - ``list``     — list the installed custom nodes.

Scaffold/validate/pack only shuffle bytes; install/uninstall write to the engine's
node path (the same ``local_nodes`` the capsule installer and ``--node_path`` share).
"""

import base64
from typing import TYPE_CHECKING, Any, Dict, List

from ai.common.dap import DAPConn
from ai.account import Store
from ai.account.node_scaffold import scaffold_node, validate_node
from ai.account.capsule import pack_capsule, read_capsule
from ai.account.node_install import (
    install_capsule_to_store,
    uninstall_node_from_store,
    list_installed_in_store,
)

if TYPE_CHECKING:
    pass


class NodeDevCommands(DAPConn):
    """Node Builder command group. Mixed into ``TaskConn``."""

    async def on_rrext_node_dev(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Route ``rrext_node_dev`` by ``arguments.subcommand``."""
        args = request.get('arguments') or {}
        subcommand = args.get('subcommand')
        if not subcommand:
            raise ValueError('Subcommand is required')
        if subcommand == 'scaffold':
            return self._node_scaffold(args)
        if subcommand == 'validate':
            return self._node_validate(args)
        if subcommand == 'pack':
            return self._node_pack(args)
        if subcommand == 'inspect':
            return self._node_inspect(args)
        if subcommand == 'install':
            return await self._node_install(args)
        if subcommand == 'uninstall':
            return await self._node_uninstall(args)
        if subcommand == 'list':
            return {'nodes': await list_installed_in_store(self._node_store())}
        raise ValueError(f'unknown rrext_node_dev subcommand {subcommand!r}')

    def _node_scaffold(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Render a node folder from the request args and return the file map."""
        name = args.get('name')
        files = scaffold_node(
            name=name,
            title=args.get('title'),
            kind=args.get('kind', 'filter'),
            class_type=args.get('classType'),
            lanes=args.get('lanes'),
            description=args.get('description'),
        )
        return {'name': name, 'protocol': f'{name}://', 'files': files}

    def _node_validate(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Validate a node folder (its file map) and return ok/errors/warnings."""
        name = args.get('name')
        files = args.get('files') or {}
        return validate_node(name, files)

    def _node_pack(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Build a .rrc capsule from a node file map; return it base64-encoded."""
        name = args.get('name')
        files = args.get('files') or {}
        blob = pack_capsule(name, files, version=args.get('version', '0.0.0'), declares=args.get('declares'))
        return {'name': name, 'capsule': base64.b64encode(blob).decode('ascii')}

    def _node_inspect(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Report what a .rrc capsule contains and whether it would load — without writing it.

        Installing a capsule puts Python on disk that the task subprocess imports, so
        the contents are worth seeing before that happens rather than after. Nothing
        here touches the store: reading the archive already verifies the manifest, the
        recorded digest and every payload path, and validate_node then answers whether
        the engine could register the node at all.

        Args:
            args: ``{'capsule': base64 .rrc}``.

        Returns:
            ``{name, protocol, version, declares, sizeBytes, files: [{path, bytes}],
            totalBytes, ok, errors, warnings, replaces}`` — ``replaces`` names the
            installed node this would overwrite, when there is one.
        """
        capsule = args.get('capsule')
        if not capsule:
            raise ValueError('capsule (base64 .rrc) is required')
        blob = base64.b64decode(capsule)
        manifest, payload = read_capsule(blob)
        name = manifest.get('name')

        # validate_node reads text; a capsule may legitimately carry binary (an icon),
        # so anything undecodable is reported by name instead of failing the read.
        text_files: Dict[str, str] = {}
        binary_files: List[str] = []
        for path, body in payload.items():
            try:
                text_files[path] = body.decode('utf-8')
            except UnicodeDecodeError:
                binary_files.append(path)

        verdict = validate_node(name, text_files)
        return {
            'name': name,
            'protocol': manifest.get('protocol') or f'{name}://',
            'version': manifest.get('version'),
            'declares': manifest.get('declares') or [],
            'sizeBytes': len(blob),
            'totalBytes': sum(len(body) for body in payload.values()),
            'files': sorted(
                ({'path': path, 'bytes': len(body)} for path, body in payload.items()),
                key=lambda entry: entry['path'],
            ),
            'binaryFiles': sorted(binary_files),
            'ok': verdict.get('ok'),
            'errors': verdict.get('errors') or [],
            'warnings': verdict.get('warnings') or [],
        }

    def _node_store(self):
        """The caller's FileStore — installs persist here and materialize per-run."""
        return Store.file_store(self.request_context())

    async def _node_install(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Install a base64 .rrc capsule into the caller's store (local_nodes/)."""
        capsule = args.get('capsule')
        if not capsule:
            raise ValueError('capsule (base64 .rrc) is required')
        return await install_capsule_to_store(self._node_store(), base64.b64decode(capsule))

    async def _node_uninstall(self, args: Dict[str, Any]) -> Dict[str, Any]:
        """Remove an installed custom node by name from the caller's store."""
        return await uninstall_node_from_store(self._node_store(), args.get('name'))
