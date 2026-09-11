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

from rocketlib import IGlobalBase, OPEN_MODE, warning

from .slack_events import resolve_signing_secret


class IGlobal(IGlobalBase):
    """Manage Slack signing-secret configuration for the endpoint lifecycle."""

    def validateConfig(self) -> None:
        """Warn when no Slack signing secret is configured."""
        config = self.IEndpoint.endpoint.serviceConfig.get('parameters', {})
        if not resolve_signing_secret(config):
            warning('Slack signing secret is missing.')

    def beginGlobal(self) -> None:
        """Resolve and assign the signing secret before source execution."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        config = self.IEndpoint.endpoint.serviceConfig.get('parameters', {})
        self.signing_secret = resolve_signing_secret(config)
        self.IEndpoint._signing_secret = self.signing_secret
        if not self.signing_secret:
            warning('Slack signing secret is missing.')

    def endGlobal(self) -> None:
        """Clear the signing secret after source execution ends."""
        self.signing_secret = ''
        self.IEndpoint._signing_secret = ''
