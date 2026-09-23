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

"""
GoHighLevel tool node - global (shared) state.

Reads the sub-account Private Integration Token, the location id it is scoped to,
the read-only flag, the published tool groups, and the raw-request switch from config.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .tool_groups import DEFAULT_GROUPS, normalize_groups, unknown_groups

#: Every Private Integration Token observed so far carries this prefix. It is not a
#: documented guarantee, so a token without it is warned about and still used.
TOKEN_PREFIX = 'pit-'


class IGlobal(IGlobalBase):
    """Global state for tool_gohighlevel."""

    token: str = ''
    location_id: str = ''
    read_only: bool = False
    tool_groups: frozenset = DEFAULT_GROUPS
    allow_raw_request: bool = True

    def beginGlobal(self) -> None:
        """Read the node config and fail early when the node cannot reach an account.

        Raises:
            Exception: If the token or the location id is missing. Both are required:
                the token is opaque, so the location cannot be derived from it, and
                without a location id GoHighLevel answers 403 with a message that
                blames the token rather than the missing parameter.
            ValueError: If ``toolGroups`` is configured but names no group this node
                implements. Falling back to the defaults there would publish more
                tools than the operator asked for; see ``normalize_groups``.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import load_depends

        load_depends(__file__)

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.token = str((cfg.get('privateIntegrationToken') or '')).strip()
        self.location_id = str((cfg.get('locationId') or '')).strip()
        self.read_only = bool(cfg.get('readOnly', False))
        self.tool_groups = normalize_groups(cfg.get('toolGroups'))
        self.allow_raw_request = bool(cfg.get('allowRawRequest', True))

        # A wholly unknown toolGroups value raised in normalize_groups above. A partially
        # unknown one narrows to the names that matched, which is what the operator asked
        # for minus the typo, so it runs, but the dropped names go to the job log: the
        # editor warning in validateConfig is invisible to a deployed pipeline.
        dropped = unknown_groups(cfg.get('toolGroups'))
        if dropped:
            warning(
                f'tool_gohighlevel: ignoring unknown tool group(s): {", ".join(dropped)}. '
                f'Publishing: {", ".join(sorted(self.tool_groups))}'
            )

        if not self.token:
            raise Exception('tool_gohighlevel: privateIntegrationToken is required')
        if not self.location_id:
            raise Exception('tool_gohighlevel: locationId is required (the sub-account this token is scoped to)')

    def validateConfig(self) -> None:
        """Surface config problems in the editor without starting the backend."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            token = str((cfg.get('privateIntegrationToken') or '')).strip()
            if not token:
                warning('privateIntegrationToken is required')
            elif not token.startswith(TOKEN_PREFIX):
                warning(
                    'privateIntegrationToken does not start with "pit-": agency tokens, OAuth access tokens '
                    'and v1 API keys are not accepted by this node'
                )
            if not str((cfg.get('locationId') or '')).strip():
                warning('locationId is required (the sub-account this Private Integration Token is scoped to)')
            unknown = unknown_groups(cfg.get('toolGroups'))
            if unknown:
                warning(f'unknown tool group(s): {", ".join(unknown)}')
            try:
                normalize_groups(cfg.get('toolGroups'))
            except ValueError:
                warning('toolGroups matches no known group, so the pipeline will fail to start')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        """Release shared state, wiping the credential."""
        self.token = ''
        self.location_id = ''
        self.read_only = False
        self.tool_groups = DEFAULT_GROUPS
        self.allow_raw_request = True
