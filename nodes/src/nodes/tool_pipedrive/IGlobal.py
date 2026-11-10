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
Pipedrive tool node - global (shared) state.

Reads the API token, company domain, read-only flag, published tool groups,
and the raw-request switch from the resolved node config.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, warning

from .pipedrive_client import BASE_URL, BASE_URL_V2, base_url_for, base_url_v2_for
from .tool_groups import (
    DEFAULT_GROUPS,
    RECOMMENDED_TOOL_LIMIT,
    normalize_groups,
    published_tool_count,
    wants_all_groups,
)


class IGlobal(IGlobalBase):
    """Global state for tool_pipedrive."""

    token: str = ''
    company_domain: str = ''
    base_url: str = BASE_URL
    #: Search tools only - Pipedrive retired the v1 search routes.
    base_url_v2: str = BASE_URL_V2
    read_only: bool = False
    tool_groups: frozenset = DEFAULT_GROUPS
    allow_raw_request: bool = True

    def beginGlobal(self) -> None:
        # The resolved config: the token a required secret (a ${ROCKETRIDE_PIPEDRIVE_TOKEN}
        # reference resolved per call), toolGroups pinned to the groups this node
        # implements, so an unknown group never reaches here
        cfg = self.config
        self.token = str(cfg.apiToken or '').strip()
        self.company_domain = str(cfg.companyDomain or '').strip()
        self.base_url = base_url_for(self.company_domain)
        self.base_url_v2 = base_url_v2_for(self.company_domain)
        self.read_only = cfg.readOnly
        self.tool_groups = normalize_groups(cfg.toolGroups)
        self.allow_raw_request = cfg.allowRawRequest

        if not self.token:
            raise Exception('tool_pipedrive: apiToken is required')

        oversized = _oversized_warning(cfg.toolGroups, self.tool_groups)
        if oversized:
            warning(oversized)

    def endGlobal(self) -> None:
        self.token = ''
        self.company_domain = ''
        self.base_url = BASE_URL
        self.base_url_v2 = BASE_URL_V2
        self.read_only = False
        self.tool_groups = DEFAULT_GROUPS
        self.allow_raw_request = True


def _oversized_warning(raw, groups) -> str:
    """Warn when the selected groups publish more tools than an LLM handles well.

    Advisory only - the tools are still published. ``all`` is an explicit opt-in
    to the whole surface and is exempt.
    """
    if wants_all_groups(raw):
        return ''
    try:
        total = published_tool_count(groups)
    except Exception:
        return ''
    if total <= RECOMMENDED_TOOL_LIMIT:
        return ''
    return (
        f'toolGroups publishes {total} tools, above the recommended {RECOMMENDED_TOOL_LIMIT}. '
        'Agents pick the wrong tool more often at this size, and some providers reject more '
        'than 128 tools in one request. Drop a group, or use "all" if this is deliberate.'
    )
