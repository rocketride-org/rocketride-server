# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.


"""Node distribution: control a published node on the deployments registry.

Publishing a node version is NOT here — it rides the generic rail as
``deploy(kind='node')``, which carries the zip. These are the verbs that
control one afterwards, the same split apps use: one door to put code on the
server, one surface to control it.

A published version is INERT. Nothing can reach it until an audience is
pinned to it, and pinning is what first release, update and rollback all are.
"""

from typing import Any, Dict, List


class NodesMixin:
    """Node publish control over ``rrext_deploy_node``."""

    async def node_versions(self, node_id: str) -> List[Dict[str, Any]]:
        """
        The node's version rail, newest first.

        Args:
            node_id: The node's id — its protocol without the '://'.

        Returns:
            One row per registry version: ``registryVersion`` (the handle
            every other verb takes), the node's own ``nodeVersion``,
            ``runtime``, ``state``, ``sha256``, and who published it.
        """
        body = await self.call('rrext_deploy_node', subcommand='versions', nodeId=node_id)
        return body.get('versions', []) if isinstance(body, dict) else []

    async def deploy_node(self, node_id: str, registry_version: int, target: str = '@me') -> Dict[str, Any]:
        """
        Point an audience at one registry version.

        First release, update and rollback are all this one call — rolling
        back is pinning the older number again.

        Args:
            node_id:          The node's id.
            registry_version: The REGISTRY version number from the rail, not
                              the node's own semver: two versions can carry
                              the same semver, and only one is that row.
            target:           '@me', '@team/<name-or-id>' or '@public'.
                              '@public' needs the org's developer namespace.

        Returns:
            Dict with the ``publish`` binding row and the ``audience`` it serves.
        """
        return await self.call(
            'rrext_deploy_node',
            subcommand='deploy',
            nodeId=node_id,
            version=registry_version,
            target=target,
        )

    async def where_node(self, node_id: str) -> List[Dict[str, Any]]:
        """
        Which audience holds which version.

        Args:
            node_id: The node's id.

        Returns:
            One row per live binding.
        """
        body = await self.call('rrext_deploy_node', subcommand='where', nodeId=node_id)
        return body.get('pins', []) if isinstance(body, dict) else []

    async def disable_node(self, node_id: str, target: str = '@me') -> Dict[str, Any]:
        """
        Stop serving one binding, reversibly.

        The version is untouched — published versions are immutable and stay
        on the registry, which is what keeps a later rollback possible. Bind
        again and the node is back.

        Args:
            node_id: The node's id.
            target:  The audience to stop serving, or '@all' for every one
                     the node currently has. '@all' checks permission on all
                     of them before touching any, so it withdraws all or none.

        Returns:
            Dict with the withdrawn binding, or all of them for '@all'.
        """
        return await self.call('rrext_deploy_node', subcommand='disable', nodeId=node_id, target=target)

    async def remove_node(self, node_id: str, target: str = '@me') -> Dict[str, Any]:
        """
        Take a binding out of the listing.

        Like ``disable_node``, this acts on the BINDING and never on the
        version.

        Args:
            node_id: The node's id.
            target:  The audience to remove, or '@all' for every one it has.

        Returns:
            Dict with the removed binding, or all of them for '@all'.
        """
        return await self.call('rrext_deploy_node', subcommand='remove', nodeId=node_id, target=target)
