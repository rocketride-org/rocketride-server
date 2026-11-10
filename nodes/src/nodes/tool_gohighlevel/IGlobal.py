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
the read-only flag, the published tool groups, and the raw-request switch from the
resolved node config.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, warning

from .tool_groups import DEFAULT_GROUPS, normalize_groups

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
        """Read the resolved node config and fail early when the node cannot reach an account.

        The schema requires the token and the location id (the token is opaque, so the
        location cannot be derived from it, and without a location id GoHighLevel
        answers 403 with a message that blames the token) and pins ``toolGroups`` to
        the groups this node implements, so a misspelt group never reaches here.

        Raises:
            Exception: If the token or the location id is blank after stripping.
        """
        from depends import load_depends

        load_depends(__file__)

        cfg = self.config
        # The token reaches the node through its config (a ${ROCKETRIDE_GOHIGHLEVEL_TOKEN}
        # reference resolved per call)
        self.token = str(cfg.privateIntegrationToken or '').strip()
        self.location_id = str(cfg.locationId or '').strip()
        self.read_only = cfg.readOnly
        self.tool_groups = normalize_groups(cfg.toolGroups)
        self.allow_raw_request = cfg.allowRawRequest

        if not self.token:
            raise Exception('tool_gohighlevel: privateIntegrationToken is required')
        if not self.token.startswith(TOKEN_PREFIX):
            warning(
                'tool_gohighlevel: privateIntegrationToken does not start with "pit-": agency tokens, OAuth access '
                'tokens and v1 API keys are not accepted by this node'
            )
        if not self.location_id:
            raise Exception('tool_gohighlevel: locationId is required (the sub-account this token is scoped to)')

    def endGlobal(self) -> None:
        """Release shared state, wiping the credential."""
        self.token = ''
        self.location_id = ''
        self.read_only = False
        self.tool_groups = DEFAULT_GROUPS
        self.allow_raw_request = True
