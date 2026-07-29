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

The teams-as-environments model: PUBLISH creates an immutable, sha256-locked
artifact version in the ORG registry; DEPLOY points a TEAM at a version
(promotion and rollback are the same pointer move); every publish and every
pointer change is recorded immutably in the audit history.

Types:
    DeployActor:        Denormalized who-did-it identity on audit records.
    DeployArtifact:     One immutable registry version (publish result).
    DeploymentSchedule: Per-source cron schedule on a team deployment.
    Deployment:         One team's deployment of a project (registry-joined).
    DeployHistoryEntry: One immutable audit-trail row.
    PublishResult:      publish() body: the artifact (+ deployment when
                        deploy_to was given).
    DeployListResult:   Standard list envelope of Deployment rows.
    DeployVersionsResult: Standard list envelope of DeployArtifact rows.
    DeployHistoryResult:  Standard list envelope of DeployHistoryEntry rows.
    SchedulePreview:    preview() body: validity + next occurrences.
"""

from typing import Literal, TypedDict


class DeployActor(TypedDict, total=False):
    """Denormalized audit identity — survives account deletion."""

    userId: str
    display: str
    email: str


class DeployArtifact(TypedDict, total=False):
    """One immutable registry version of a project's pipeline."""

    version: int
    # sha256 over the exact stored artifact bytes; verified on every load.
    sha256: str
    bytes: int
    pipelineName: str
    publishedBy: DeployActor
    # Unix timestamp (seconds).
    publishedAt: float
    # Optional "what changed" note supplied at publish time.
    comment: str


class DeploymentSchedule(TypedDict, total=False):
    """Per-source schedule on a team deployment."""

    # 5-field cron expression.
    cron: str
    # Paused schedules stay configured (cron/ttl kept) but never fire.
    paused: bool
    # Run window in seconds ('fixed window'); absent/None = until finished.
    ttl: int
    # Trace verbosity for this source's deploy runs; absent/None = the
    # deploy default (full).
    traceLevel: Literal['none', 'metadata', 'summary', 'full']
    # Full task debug output (--trace=debugOut) for this source.
    debugOut: bool
    # Unix timestamp (seconds) of the last scheduler dispatch, or None.
    lastRunAt: float


class Deployment(TypedDict, total=False):
    """One team's deployment of a project, joined with registry info."""

    teamId: str
    projectId: str
    # The registry version this team currently points at.
    version: int
    # 'disabled' is the whole-deployment kill switch — nothing runs.
    state: Literal['enabled', 'disabled', 'errored', 'removed']
    pipelineName: str
    # Per-source schedules, keyed by source id.
    schedules: dict[str, DeploymentSchedule]
    createdAt: float
    createdBy: DeployActor
    updatedAt: float
    updatedBy: DeployActor
    # Unix seconds of the latest POINTER MOVE for this team (deploy or
    # rollback), computed from the audit trail — unlike updatedAt, it is
    # NOT bumped by disable/enable or schedule edits.
    deployedAt: float
    # Registry-joined fields of the pointed-at version.
    sha256: str
    publishedAt: float
    publishedBy: DeployActor


class DeployHistoryEntry(TypedDict, total=False):
    """One immutable audit-trail row (who did what, where, when)."""

    # Stable append-order key: newest first, never ties. Use as the row
    # identity when rendering.
    seq: int
    # Unix timestamp (seconds).
    at: float
    # 'pause'/'resume' appear only on rows written before the enable/disable
    # vocabulary (the trail is immutable).
    action: Literal['publish', 'deploy', 'rollback', 'enable', 'disable', 'pause', 'resume', 'errored', 'remove']
    # '' on org-wide rows (publish); the team id on pointer changes.
    teamId: str
    version: int
    actor: DeployActor


class PublishResult(TypedDict, total=False):
    """Body of ``deploy.publish``."""

    artifact: DeployArtifact
    # Present only when deploy_to was given (one-step publish+deploy).
    deployment: Deployment


class DeployListResult(TypedDict, total=False):
    """Standard list envelope of Deployment rows."""

    rows: list[Deployment]
    total: int
    page: int
    pageSize: int


class DeployVersionsResult(TypedDict, total=False):
    """Standard list envelope of DeployArtifact rows (newest first)."""

    rows: list[DeployArtifact]
    total: int
    page: int
    pageSize: int


class DeployHistoryResult(TypedDict, total=False):
    """Standard list envelope of DeployHistoryEntry rows (newest first)."""

    rows: list[DeployHistoryEntry]
    total: int
    page: int
    pageSize: int


class SchedulePreview(TypedDict, total=False):
    """Body of ``deploy.preview`` — THE single cron evaluator."""

    valid: bool
    # Human-readable reason when invalid.
    error: str
    # Unix timestamps (seconds) of the next occurrences.
    next: list[float]
