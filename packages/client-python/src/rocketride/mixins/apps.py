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

"""
App publish ladder for RocketRide Client.

Typed wrappers over the ``rrext_app_deploy`` DAP command: publish an
immutable app version, list the version rail, pin a rung (deploy — one
verb covers first publish, update, promote, and rollback), and read the
reverse index (where). Mirrors the TypeScript client's appPublish /
appVersions / appDeploy / appWhere.
"""

from typing import Any, Dict, List, Optional

from ..core import DAPClient


class AppsMixin(DAPClient):
    """Publish-ladder operations for RocketRide apps (rrext_app_deploy)."""

    async def app_publish(
        self,
        app_id: str,
        version: str,
        bundle: bytes,
        message: str = '',
        module_id: Optional[str] = None,
        name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Publish an immutable app version to the org registry.

        Publishing never activates anything — pin a rung with
        :meth:`app_deploy` to make the version live somewhere.

        Args:
            app_id:    App id (appManifest.id, e.g. 'acme.brandy').
            version:   Semver label for the version (e.g. '0.5.0').
            bundle:    The built remoteEntry.js bytes (single-file v1).
            message:   Commit-style "what changed" note for the version card.
            module_id: MF container name (derived from app_id when omitted).
            name:      Display name (defaults to app_id).

        Returns:
            The version-rail entry (registryVersion, appVersion, sha256,
            publishedAt, author, message).
        """
        body = await self.call(
            'rrext_app_deploy',
            subcommand='publish',
            appId=app_id,
            version=version,
            message=message,
            moduleId=module_id,
            name=name,
            data=bundle,
        )
        return body.get('entry', {})

    async def app_versions(self, app_id: str) -> List[Dict[str, Any]]:
        """
        List the app's published versions, newest first (the rail).

        Args:
            app_id: App id.

        Returns:
            Rail entries, each with a ``rungs`` list naming the rungs
            currently pinned to that version.
        """
        body = await self.call('rrext_app_deploy', subcommand='versions', appId=app_id)
        return body.get('versions', [])

    async def app_deploy(self, app_id: str, registry_version: int, target: str) -> Dict[str, Any]:
        """
        Pin a rung to a published version (deploy / promote / rollback).

        Args:
            app_id:           App id.
            registry_version: Registry version number from the rail.
            target:           '@user', '@team/<name-or-id>', or '@org'.

        Returns:
            Dict with the updated ``deployment`` record and the ``rung``.
        """
        return await self.call(
            'rrext_app_deploy',
            subcommand='deploy',
            appId=app_id,
            version=registry_version,
            target=target,
        )

    async def app_where(self, app_id: str) -> List[Dict[str, Any]]:
        """
        The reverse index: which rungs run which version of the app.

        Args:
            app_id: App id.

        Returns:
            Pin rows ({rung, handle, version, appVersion, state, deployedAt}).
        """
        body = await self.call('rrext_app_deploy', subcommand='where', appId=app_id)
        return body.get('pins', [])
