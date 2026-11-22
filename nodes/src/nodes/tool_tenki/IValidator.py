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

"""Luxor Sandbox tool node: what the editor is told when the node is saved.

The engine imports this module alone in CONFIG mode, so it imports no SDK
(``IGlobal.py`` installs and imports ``luxor_ai`` when it loads). The schema
check is the resolver (``self.config``). The semantic check is the Tenki-era
names: a ``tk_`` key or a ``tenki.cloud`` endpoint still works until Luxor
retires it on 2027-01-01, and the user is warned while still editing the
node. ``IGlobal.beginGlobal`` logs the same warnings from the same helpers
when the pipeline starts.
"""

from __future__ import annotations

import urllib.parse

from rocketlib import IValidatorBase, warning

# Luxor's API, the default of tenki.base_url in services.json; what Tenki's API host is read as, and named in warnings.
_DEFAULT_BASE_URL = 'https://api.luxor.ai'
# Tenki's API host, which Luxor serves as api.luxor.ai until it stops answering on 2027-01-01.
_TENKI_API_HOST = 'api.tenki.cloud'


def _host_of(base_url: str) -> str:
    """base_url's host in lower case, or '' when it is not a URL (building the SDK's client reports that)."""
    url = base_url
    if '://' not in url:
        url = f'https://{url}'
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:  # a stray [ or ], or a bracketed host that is not an IP address
        return ''
    return parts.hostname or ''  # hostname is already lower case


def _effective_base_url(base_url: str) -> str:
    """The URL the node connects to: Tenki's API host is read as Luxor's, the same service, which outlives it."""
    if _host_of(base_url) == _TENKI_API_HOST:
        return _DEFAULT_BASE_URL
    return base_url


def _retired_names(apikey: str, base_url: str) -> list[str]:
    """A warning for each Tenki-era name configured: Luxor retires tk_ keys and tenki.cloud hosts on 2027-01-01."""
    # TODO(#3411): once 2027-01-01 has passed, drop the tk_ handling and the dated warnings. Keep
    # _effective_base_url's swap: pipelines saved with api.tenki.cloud need it most once that host stops answering.
    retired = []
    if apikey.startswith('tk_'):
        retired.append(
            'apikey is a Tenki key (tk_), which stops working on 2027-01-01: create a Luxor key (lx_) in the Luxor '
            'dashboard and use it instead'
        )
    host = _host_of(base_url)
    effective = _effective_base_url(base_url)
    if effective != base_url:
        retired.append(
            f'tenki.base_url points at {host}, which stops working on 2027-01-01, so the node connects to '
            f'{effective}, the same service, instead: set tenki.base_url to {effective} to drop this warning'
        )
    elif host == 'tenki.cloud' or host.endswith('.tenki.cloud'):
        retired.append(
            f'tenki.base_url points at {host}, which stops working on 2027-01-01: set it to {_DEFAULT_BASE_URL}'
        )
    return retired


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the names Luxor retires."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config, then warn about a Tenki key or a tenki.cloud endpoint.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        cfg = self.config
        if syntaxOnly:
            return
        for retired in _retired_names(str(cfg.apikey or '').strip(), str(cfg.base_url or '').strip()):
            warning(retired)
