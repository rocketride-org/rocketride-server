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

"""Google Drive global state backed by the shared Workspace lifecycle."""

from ..IGlobal import GoogleToolGlobalBase
from .client import SERVICE, resolve_account_domain


class IGlobal(GoogleToolGlobalBase):
    """Global state for Drive: resolved access, Drive v3 service, and account domain."""

    SERVICE = SERVICE
    SPEC_NAME = 'DRIVE'
    account_domain = None

    def _after_begin(self, cfg: dict) -> None:
        auth_type = (cfg.get('authType') or 'service').strip()
        self.account_domain = resolve_account_domain(auth_type, cfg)

    def endGlobal(self) -> None:
        super().endGlobal()
        self.account_domain = None
