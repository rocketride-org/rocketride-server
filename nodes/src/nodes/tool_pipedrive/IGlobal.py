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
Pipedrive tool node - global (shared) state.

Reads the API token, company domain, read-only flag, published tool groups,
and the raw-request switch from config.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .pipedrive_client import BASE_URL, BASE_URL_V2, base_url_for, base_url_v2_for
from .tool_groups import (
    ALL_GROUPS,
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
    #: Search tools only — Pipedrive retired the v1 search routes.
    base_url_v2: str = BASE_URL_V2
    read_only: bool = False
    tool_groups: frozenset = DEFAULT_GROUPS
    allow_raw_request: bool = True

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self.token = str((cfg.get('apiToken') or '')).strip()
        self.company_domain = str((cfg.get('companyDomain') or '')).strip()
        self.base_url = base_url_for(self.company_domain)
        self.base_url_v2 = base_url_v2_for(self.company_domain)
        self.read_only = bool(cfg.get('readOnly', False))
        self.tool_groups = normalize_groups(cfg.get('toolGroups'))
        self.allow_raw_request = bool(cfg.get('allowRawRequest', True))

        if not self.token:
            raise Exception('tool_pipedrive: apiToken is required')

        oversized = _oversized_warning(cfg.get('toolGroups'), self.tool_groups)
        if oversized:
            warning(oversized)

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            if not str((cfg.get('apiToken') or '')).strip():
                warning('apiToken is required')
            unknown = _unknown_groups(cfg.get('toolGroups'))
            if unknown:
                warning(f'unknown tool group(s): {", ".join(unknown)}')
            oversized = _oversized_warning(cfg.get('toolGroups'), normalize_groups(cfg.get('toolGroups')))
            if oversized:
                warning(oversized)
        except Exception as e:
            warning(str(e))

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

    Advisory only — the tools are still published. ``all`` is an explicit opt-in
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


def _unknown_groups(raw) -> list[str]:
    """Group names in the config that this node does not implement."""
    if not isinstance(raw, (list, tuple)):
        return []
    known = ALL_GROUPS | {'all'}
    return sorted({str(g).strip() for g in raw if str(g).strip() and str(g).strip() not in known})
