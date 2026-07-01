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
Deploy type definitions for the RocketRide Python SDK.

Types:
    DeploymentRecord:   Deployment record as returned by add / list / status.
"""

from typing import Literal, TypedDict

from .pipeline import PipelineConfig


class DeploymentRecord(TypedDict, total=False):
    """
    Deployment record returned by ``deploy.add``, ``deploy.list``, and
    ``deploy.status``.
    """

    pipeline: PipelineConfig
    # Cron expression (e.g. '*/15 * * * *') or 'manual' for on-demand only.
    schedule: str
    state: Literal['active', 'paused', 'errored']
    # ID of the user who created the deployment.
    userId: str
    # Unix timestamps (seconds).
    createdAt: float
    updatedAt: float
