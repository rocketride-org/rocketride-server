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
    from google.cloud import aiplatform
except ImportError:
    aiplatform = None

_VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']


class IGlobal(IGlobalBase):
    """Global state for Vertex AI Vector Search node."""

    index_endpoint = None
    deployed_index_id: str = ''
    location: str = 'us-central1'
    project_id: str = ''

    def beginGlobal(self) -> None:
        """Connect to the configured Vertex Matching Engine index endpoint."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        if aiplatform is None:
            raise ImportError('google-cloud-aiplatform is not installed.')

        # deferred: engine-path import
        from nodes.core.gcp_auth import get_gcp_credentials

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.location = str((cfg.get('location') or 'us-central1')).strip()
        index_endpoint_id = str((cfg.get('indexEndpointId') or '')).strip()
        self.deployed_index_id = str((cfg.get('deployedIndexId') or '')).strip()

        if not index_endpoint_id or not self.deployed_index_id:
            raise ValueError('indexEndpointId and deployedIndexId are required for Vertex AI Vector Search.')

        # Auth
        try:
            creds, self.project_id = get_gcp_credentials(cfg, scopes=_VERTEX_SCOPES)
        except Exception as e:
            warning(f'Vertex AI authentication failed: {e}')
            raise

        # Pass project/location/credentials to the endpoint constructor — do not
        # call aiplatform.init(), which mutates process-global SDK state.
        try:
            self.index_endpoint = aiplatform.MatchingEngineIndexEndpoint(
                index_endpoint_name=index_endpoint_id,
                project=self.project_id,
                location=self.location,
                credentials=creds,
            )
            deployed = list(getattr(self.index_endpoint, 'deployed_indexes', None) or [])
            deployed_ids = {str(getattr(idx, 'id', '') or '') for idx in deployed}
            if self.deployed_index_id not in deployed_ids:
                raise ValueError(
                    f'deployedIndexId {self.deployed_index_id!r} is not deployed on index endpoint {index_endpoint_id}.'
                )
            debug(f'tool_vertex_search: connected to index endpoint {index_endpoint_id}')
        except Exception as e:
            warning(f'Vertex AI connection check failed: {e}')
            raise

    def validateConfig(self) -> None:
        """Warn on missing auth or required Vertex index settings."""
        # deferred: engine-path import
        from nodes.core.gcp_auth import get_gcp_credentials, GCPAuthError

        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            get_gcp_credentials(cfg, scopes=_VERTEX_SCOPES)
            if not str(cfg.get('indexEndpointId') or '').strip():
                warning('indexEndpointId is required')
            if not str(cfg.get('deployedIndexId') or '').strip():
                warning('deployedIndexId is required')
        except GCPAuthError as e:
            warning(f'Auth configuration error: {e}')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Drop the index endpoint handle."""
        self.index_endpoint = None
