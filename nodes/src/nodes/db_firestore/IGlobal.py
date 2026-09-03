# =============================================================================
# RocketRide Engine
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

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

try:
    from google.cloud import firestore
except ImportError:
    firestore = None

_FIRESTORE_SCOPES = ['https://www.googleapis.com/auth/datastore']


class IGlobal(IGlobalBase):
    """Global state for Firestore node."""

    client: firestore.Client | None = None
    database: str = '(default)'
    collection: str = ''

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        if firestore is None:
            raise ImportError('google-cloud-firestore is not installed.')

        # deferred: engine-path import
        from nodes.core.gcp_auth import get_gcp_credentials

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.database = str((cfg.get('database') or '(default)')).strip() or '(default)'
        self.collection = str((cfg.get('collection') or '')).strip()

        # Auth
        try:
            creds, project_id = get_gcp_credentials(cfg, scopes=_FIRESTORE_SCOPES)
        except Exception as e:
            warning(f'Firestore authentication failed: {e}')
            raise

        self.client = firestore.Client(project=project_id, credentials=creds, database=self.database)

        # Optional connectivity probe. Listing collections needs broader IAM
        # than document get/set — warn only so narrowly-scoped SAs can still start.
        try:
            next(self.client.collections(), None)
            debug(f'db_firestore: connected to project {self.client.project}, database={self.database}')
        except Exception as e:
            warning(
                f'Firestore connection probe failed (list collections); continuing — document tools may still work: {e}'
            )

    def validateConfig(self) -> None:
        # deferred: engine-path import
        from nodes.core.gcp_auth import get_gcp_credentials, GCPAuthError

        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            get_gcp_credentials(cfg, scopes=_FIRESTORE_SCOPES)
            if not str(cfg.get('collection') or '').strip():
                warning('collection is recommended')
        except GCPAuthError as e:
            warning(f'Auth configuration error: {e}')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = None
