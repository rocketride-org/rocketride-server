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

Reads the API token and the company domain from the resolved node config.
The read-only gate, the published tool groups and the raw-request switch
are each call's settings (``PipedriveToolsBase._options``).
"""

from __future__ import annotations

from rocketlib import IGlobalBase

from .pipedrive_client import BASE_URL, BASE_URL_V2, base_url_for, base_url_v2_for


class IGlobal(IGlobalBase):
    """Global state for tool_pipedrive: the account token and its API bases."""

    token: str = ''
    company_domain: str = ''
    base_url: str = BASE_URL
    #: Search tools only - Pipedrive retired the v1 search routes.
    base_url_v2: str = BASE_URL_V2

    def beginGlobal(self) -> None:
        # The resolved config: the token a required secret (a ${ROCKETRIDE_PIPEDRIVE_TOKEN}
        # reference resolved per call)
        cfg = self.config
        self.token = str(cfg.apiToken or '').strip()
        self.company_domain = str(cfg.companyDomain or '').strip()
        self.base_url = base_url_for(self.company_domain)
        self.base_url_v2 = base_url_v2_for(self.company_domain)

        if not self.token:
            raise Exception('tool_pipedrive: apiToken is required')

    def endGlobal(self) -> None:
        self.token = ''
        self.company_domain = ''
        self.base_url = BASE_URL
        self.base_url_v2 = BASE_URL_V2
