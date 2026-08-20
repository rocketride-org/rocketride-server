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

Typed wrappers over the ``rrext_deploy_app`` DAP command: list the version
rail, publish a deployment to an audience (one verb covers update, promote,
and rollback), and read the reverse index (where). Serving needs no verb:
versions load from stable ``/apps/<appId>/v<N>/`` URLs constructed from the
version number, entitlement enforced per request by the serve route.
Uploading is the generic rail door — see :meth:`DeployApi.add` (``client.deploy.add``).
Mirrors the TypeScript client's listDeployments / publishApp / whereApp / replyApp.
"""

from typing import Any, Dict, List, Optional

from ..core import DAPClient


class AppsMixin(DAPClient):
    """App publish control for RocketRide apps (rrext_deploy_app)."""

    async def list_deployments(self, app_id: str) -> List[Dict[str, Any]]:
        """
        List the app's deployed versions, newest first (the rail).

        Answered by role: the developer org sees its FULL rail (published or
        not); other callers see only the versions serving on rows visible to
        them. Mirrors the TypeScript client's ``listDeployments``.

        Args:
            app_id: App id.

        Returns:
            Rail entries, each with its deployment ``state``, its
            ``buildStatus`` ('ok' = servable bytes exist), and a ``rungs``
            list naming the audiences currently serving that version.
        """
        body = await self.call('rrext_deploy_app', subcommand='versions', appId=app_id)
        return body.get('versions', [])

    async def submit_app(self, app_id: str, registry_version: int) -> Dict[str, Any]:
        """
        Submit a deployed version for store review.

        Flips the DEPLOYMENT's own state 'private' -> 'submit' (it enters the
        sys.admin review queue). The review state lives on the deployment, not
        a binding. Developer-org and developer-namespace gated.

        Args:
            app_id:           App id.
            registry_version: Registry version number from the rail.

        Returns:
            Dict with the refreshed ``artifact`` rail entry.
        """
        return await self.call(
            'rrext_deploy_app',
            subcommand='submit',
            appId=app_id,
            version=registry_version,
        )

    async def withdraw_app(self, app_id: str, registry_version: int) -> Dict[str, Any]:
        """
        Withdraw a pending review — the developer's own cancel.

        Flips the DEPLOYMENT 'submit' -> 'private': the version leaves the
        admin queue and returns to draft (internally publishable as before);
        history records 'withdrawn'. Only a version in 'submit' withdraws.
        Developer-org and developer-namespace gated, like submit.

        Args:
            app_id:           App id.
            registry_version: Registry version number from the rail.

        Returns:
            Dict with the refreshed ``artifact`` rail entry.
        """
        return await self.call(
            'rrext_deploy_app',
            subcommand='withdraw',
            appId=app_id,
            version=registry_version,
        )

    async def reply_app(self, app_id: str, message: str, registry_version: Optional[int] = None) -> Dict[str, Any]:
        """
        Append a developer message to the app's review thread.

        The developer half of the reviewer conversation: the message rides
        the app's deployment history as a 'reply' row (side 'developer'),
        the same stream ``deploy.history()`` reads and the store reviewer
        writes to. Developer-org and developer-namespace gated, like submit.
        Mirrors the TypeScript client's ``replyApp``.

        Args:
            app_id:           App id.
            message:          The message text (server caps the length).
            registry_version: Optional registry version the message refers to.

        Returns:
            Dict ``{'replied': True, 'appId': app_id}``.
        """
        kwargs: Dict[str, Any] = {'subcommand': 'reply', 'appId': app_id, 'message': message}
        if registry_version is not None:
            kwargs['version'] = registry_version
        return await self.call('rrext_deploy_app', **kwargs)

    async def build_log(self, app_id: str, registry_version: int) -> Dict[str, Any]:
        """
        Read one version's durable server build log.

        The full phase-by-phase output the build worker writes beside the
        version's artifacts (no error text rides the rail rows or the DB).
        Long logs serve their tail; an empty ``log`` means no log exists for
        the version. Developer-org gated. Mirrors the TypeScript client's
        ``buildLog``.

        Args:
            app_id:           App id.
            registry_version: Registry version number from the rail.

        Returns:
            Dict ``{'appId', 'version', 'log'}``.
        """
        return await self.call(
            'rrext_deploy_app',
            subcommand='build_log',
            appId=app_id,
            version=registry_version,
        )

    async def publish_app(self, app_id: str, registry_version: int, target: str) -> Dict[str, Any]:
        """
        Bind a deployment to an audience (first publish / promote / rollback).

        The binding is a pure pointer; '@public' requires the deployment be
        'ready' (approved), '@me'/'@team' accept any non-'failed' deployment.

        Args:
            app_id:           App id.
            registry_version: Registry version number from the rail.
            target:           '@me', '@team/<name-or-id>', or '@public' ('@user' = legacy alias).

        Returns:
            Dict with the ``publish`` binding row ({audience, version, state,
            artifactState, snapshot}).
        """
        return await self.call(
            'rrext_deploy_app',
            subcommand='publish',
            appId=app_id,
            version=registry_version,
            target=target,
        )

    async def remove_app_publish(self, app_id: str, target: str) -> Dict[str, Any]:
        """
        Remove an audience binding — the app stops serving to that audience.

        SOFT: the registry versions and the audit history survive; publishing
        to the audience again revives it.

        Args:
            app_id: App id.
            target: '@me', '@team/<name-or-id>', or '@public' ('@user' = legacy alias).

        Returns:
            Dict with the final ``publish`` binding row (state 'removed').
        """
        return await self.call(
            'rrext_deploy_app',
            subcommand='remove',
            appId=app_id,
            target=target,
        )

    async def disable_app_publish(self, app_id: str, target: str) -> Dict[str, Any]:
        """
        Disable an audience binding — serving stops, but the row STAYS in the
        where-live listing marked disabled (a visible off switch), unlike
        remove which hides it. Publishing any version to the rung re-enables
        the binding.

        Args:
            app_id: App id.
            target: '@me', '@team/<name-or-id>', or '@public' ('@user' = legacy alias).

        Returns:
            Dict with the ``publish`` binding row (state 'disabled').
        """
        return await self.call(
            'rrext_deploy_app',
            subcommand='disable',
            appId=app_id,
            target=target,
        )

    async def where_app(self, app_id: str) -> List[Dict[str, Any]]:
        """
        The reverse index: which audiences serve which version of the app.

        Args:
            app_id: App id.

        Returns:
            Pin rows ({rung, handle, version, appVersion, state, deployedAt}).
        """
        body = await self.call('rrext_deploy_app', subcommand='where', appId=app_id)
        return body.get('pins', [])

    # (app_entry is RETIRED: versions serve from stable constructed URLs —
    # /apps/<appId>/v<N>/remoteEntry.js — with entitlement enforced per
    # request by the serve route, so there is nothing to mint.)
