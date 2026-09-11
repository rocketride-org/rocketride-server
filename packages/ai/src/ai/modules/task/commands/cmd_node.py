# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

# =============================================================================
# CMD NODE — thin DAP router for node publish control
#
# One command (rrext_deploy_node, grouped subcommands) delegating to
# node_deploy.handle_node_deploy. Uploading a node version goes through the
# generic rail instead (rrext_deploy add, kind='node'), the same split apps
# use: one door to put code on the server, one surface to control it.
# =============================================================================

"""NodeCommands: thin DAP router for node publish control.

Exposes one command to the DAP dispatcher:

  - ``rrext_deploy_node`` — node publish control on the deployments registry
                            (``versions`` / ``deploy`` / ``where`` /
                            ``disable`` / ``remove``)

Publishing a version is NOT here: it arrives on the generic rail as
``rrext_deploy add`` with ``kind='node'``, which carries the zip.
"""

from typing import Any, Dict

from ai.common.dap import DAPConn


# =============================================================================
# NODE COMMANDS MIXIN
# =============================================================================


class NodeCommands(DAPConn):
    """DAP handlers for the node command family."""

    async def on_rrext_deploy_node(self, request: Dict[str, Any]) -> Dict[str, Any]:
        """Delegate ``rrext_deploy_node`` (node publish control) to the node handler."""
        from ai.account.node_deploy import handle_node_deploy

        return await handle_node_deploy(self, request)
