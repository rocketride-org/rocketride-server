# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Google Cloud Storage tool node - global (shared) state.

Authenticates through the shared GCP definitions (gcp.authType) and holds
the storage client every instance call goes through. The bucket, the prefix
and the download cap are per-call parameters the instance reads.
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase, debug, warning

from depends import depends

# google.cloud.storage is imported at module scope, so the requirements are
# installed before that happens. This module is only imported on the run path
# (config mode imports the validator alone), so the install never runs while a
# user is merely opening the node's settings panel.
depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

try:
    from google.cloud import storage
except ImportError:
    storage = None

_GCS_SCOPES = ['https://www.googleapis.com/auth/devstorage.read_only']


class IGlobal(IGlobalBase):
    """Global state for Google Cloud Storage node."""

    client: storage.Client | None = None

    def beginGlobal(self) -> None:
        if storage is None:
            raise ImportError('google-cloud-storage is not installed.')

        # deferred: engine-path import
        from nodes.core.gcp_auth import get_gcp_credentials

        # The control's credential: the active gcp.authType branch and the project.
        # The bucket, the prefix and the download cap are per-call parameters.
        cfg = self.config

        # Auth
        try:
            creds, project_id = get_gcp_credentials(cfg, scopes=_GCS_SCOPES)
        except Exception as e:
            warning(f'GCS authentication failed: {e}')
            raise

        self.client = storage.Client(project=project_id, credentials=creds)

        debug(f'tool_gcs: connected to project {self.client.project}')

    def gcs_client(self) -> Any:
        """The shared storage client (an accessor: instances read IGlobal through methods)."""
        return self.client

    def endGlobal(self) -> None:

        if self.client is not None:
            self.client.close()
            self.client = None
