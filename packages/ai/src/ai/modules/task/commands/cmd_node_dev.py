# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""NodeDevCommands: DAP router for the Node Builder (``rrext_node_dev``).

The Node Builder authors custom nodes. Its logic lives in the engine so every
surface — the VSCode extension, the web builder and Claude — drives it through the
same ``client.call('rrext_node_dev', ...)`` and gets identical output.

Subcommands:
  - ``scaffold`` — render a new node folder as a ``{path: contents}`` file map.
  - ``validate`` — check a node folder before it is tested or deployed.

The host writes the returned files: the VSCode extension into the user's workspace,
the cloud/Claude engine into its own node path. Scaffold only produces text and
touches no shared state, so it needs no permission gate; later verbs that persist
or deploy a node carry their own team-permission checks.
"""

from typing import TYPE_CHECKING, Dict, Any

from ai.common.dap import DAPConn
from ai.account.node_scaffold import scaffold_node, validate_node

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
