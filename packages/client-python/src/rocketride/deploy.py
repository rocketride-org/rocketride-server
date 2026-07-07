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
Deploy API namespace for the RocketRide Python SDK.

Provides typed methods for managing server-side pipeline deployments via
``rrext_deploy_*`` DAP commands over the existing WebSocket connection.

Usage:
    deployment = await client.deploy.add(pipeline=my_pipeline)
    deployments = await client.deploy.list()
    status = await client.deploy.status(deployment['project_id'])
    await client.deploy.update(deployment['project_id'], schedule='0/15 * * * *')
    await client.deploy.remove(deployment['project_id'])
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types.deploy import DeploymentRecord
from .types.pipeline import PipelineConfig

if TYPE_CHECKING:
    from .client import RocketRideClient


class DeployApi:
    """
    Deployment management namespace on RocketRideClient.

    Accessed via ``client.deploy`` — not instantiated directly. All methods
    delegate to the parent client's ``call()`` method which handles envelope
    construction, sending, error detection, and tracing.
    """

    def __init__(self, client: RocketRideClient) -> None:
        """
        Bind this namespace to its parent client.

        Args:
            client: The RocketRideClient instance that owns this namespace.
        """
        self._client = client

    # =========================================================================
    # DEPLOYMENTS
    # =========================================================================

    async def add(
        self,
        pipeline: PipelineConfig,
        *,
        schedule: str | None = None,
    ) -> DeploymentRecord:
        """
        Deploy a pipeline to the server and activate it.

        Args:
            pipeline: The pipeline definition dict to deploy.
            schedule: Cron expression or ``"manual"``. Defaults to ``"manual"`` if omitted.

        Returns:
            The created deployment record.
        """
        kwargs: dict = {'pipeline': pipeline}
        if schedule is not None:
            kwargs['schedule'] = schedule
        return await self._client.call('rrext_deploy_add', **kwargs)

    async def remove(self, project_id: str) -> None:
        """
        Undeploy and remove a pipeline from the server.

        Args:
            project_id: Project ID of the deployment to remove.
        """
        await self._client.call('rrext_deploy_remove', projectId=project_id)

    async def list(self) -> list[DeploymentRecord]:
        """
        Return the authenticated user's deployments with their status and schedule config.

        Returns:
            List of deployment summary records.
        """
        body = await self._client.call('rrext_deploy_list')
        return body.get('deployments', [])

    async def status(self, project_id: str) -> DeploymentRecord:
        """
        Get detailed status of a specific deployment.

        Args:
            project_id: Project ID of the deployment to query.

        Returns:
            The deployment record including pipeline, state, schedule, and timestamps.
        """
        return await self._client.call('rrext_deploy_status', projectId=project_id)

    async def update(
        self,
        project_id: str,
        *,
        pipeline: PipelineConfig | None = None,
        schedule: str | None = None,
    ) -> None:
        """
        Modify the schedule or pipeline config for an existing deployment.

        Both ``pipeline`` and ``schedule`` are optional — omit a parameter to leave it unchanged.

        Args:
            project_id: Project ID of the deployment to update.
            pipeline: Replacement pipeline definition, or None to leave unchanged.
            schedule: Replacement schedule configuration, or None to leave unchanged.
        """
        kwargs: dict = {'projectId': project_id}
        if pipeline is not None:
            kwargs['pipeline'] = pipeline
        if schedule is not None:
            kwargs['schedule'] = schedule
        await self._client.call('rrext_deploy_update', **kwargs)
