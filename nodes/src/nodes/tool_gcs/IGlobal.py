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

Reads the bucket, prefix and download cap from the resolved node config,
authenticates through the shared GCP definitions (gcp.authType) and holds
the storage client every instance call goes through.
"""

from __future__ import annotations

import os
from typing import List

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
# Only the most recent download is kept; a new download deletes the previous temp file.
_MAX_RETAINED_TEMP_FILES = 1


class IGlobal(IGlobalBase):
    """Global state for Google Cloud Storage node."""

    client: storage.Client | None = None
    bucket_name: str = ''
    prefix: str = ''
    max_download_bytes: int = 52428800
    temp_files: List[str] | None = None

    def beginGlobal(self) -> None:
        if storage is None:
            raise ImportError('google-cloud-storage is not installed.')

        # deferred: engine-path import
        from nodes.core.gcp_auth import get_gcp_credentials

        # The resolved config: the active gcp.authType branch flattened beside
        # the bucket settings, maxDownloadBytes a validated positive integer
        cfg = self.config

        self.bucket_name = str(cfg.bucketName or '').strip()
        self.prefix = str(cfg.prefix or '').strip()
        self.max_download_bytes = cfg.maxDownloadBytes
        self.temp_files = []

        # Auth
        try:
            creds, project_id = get_gcp_credentials(cfg, scopes=_GCS_SCOPES)
        except Exception as e:
            warning(f'GCS authentication failed: {e}')
            raise

        self.client = storage.Client(project=project_id, credentials=creds)

        # Fail fast connection check
        try:
            if self.bucket_name:
                self.client.get_bucket(self.bucket_name)
                debug(f'tool_gcs: connected to project {self.client.project}, bucket={self.bucket_name}')
            else:
                debug(f'tool_gcs: connected to project {self.client.project} with no specific bucket configured')
        except Exception as e:
            warning(f'GCS connection check failed: {e}')
            raise

    def _remove_temp_path(self, path: str) -> None:
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except OSError as e:
            warning(f'tool_gcs: failed to remove temp file {path}: {e}')

    def retain_temp_file(self, path: str) -> None:
        """Track ``path`` and delete older downloads so disk use stays bounded."""
        if self.temp_files is None:
            self.temp_files = []
        while len(self.temp_files) >= _MAX_RETAINED_TEMP_FILES:
            self._remove_temp_path(self.temp_files.pop(0))
        self.temp_files.append(path)

    def endGlobal(self) -> None:
        for path in list(self.temp_files or []):
            self._remove_temp_path(path)
        self.temp_files = None

        if self.client is not None:
            self.client.close()
            self.client = None
