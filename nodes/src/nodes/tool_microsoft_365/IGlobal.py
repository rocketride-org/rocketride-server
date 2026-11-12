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
Shared global lifecycle for the Microsoft 365 tool services.

Each service subpackage (excel/, word/, onedrive/, outlook mail/, outlook
calendar/) subclasses :class:`MicrosoftToolGlobalBase`, sets ``SERVICE`` (its
:class:`GraphService` profile) and ``SPEC_NAME`` (its AccessSpec in
``nodes.core.microsoft_access``), and inherits the whole beginGlobal /
endGlobal lifecycle. Save-time validation lives in the sibling ``IValidator``
modules. Unlike the Google Workspace base, there is no discovery-service build
here - Graph is plain REST, so ``build_auth`` returns a :class:`GraphAuth`
credential object rather than a service handle. Service-specific post-build
state hooks in via :meth:`_after_begin`.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

from rocketlib import IGlobalBase

from .graph_client import GraphService, build_auth


class MicrosoftToolGlobalBase(IGlobalBase):
    """Resolved access + built Graph auth for one Microsoft 365 service."""

    SERVICE: GraphService  # set by each service subclass
    SPEC_NAME: str = ''  # AccessSpec attribute name in nodes.core.microsoft_access

    auth: Any = None
    access: Any = None
    cfg: Any = None

    def _spec(self):
        """Resolve this service's AccessSpec (deferred: engine-path import)."""
        from nodes.core import microsoft_access

        return getattr(microsoft_access, self.SPEC_NAME)

    def _after_begin(self, cfg: Mapping) -> None:
        """Hook for service-specific post-build state (default: none)."""

    def beginGlobal(self) -> None:
        from depends import depends  # type: ignore

        # The shared requirements.txt lives at the tool_microsoft_365/ level.
        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from nodes.core.microsoft_access import resolve_microsoft_access

        # The resolved view holds the active authType branch flattened beside the
        # access tier and the gate flags (allowPublicSharing, allowHardDelete),
        # which _resolve_flags reads next to 'access'.
        cfg = self.config
        self.access = resolve_microsoft_access(cfg, self._spec())
        self.cfg = cfg
        self.auth = build_auth(self.SERVICE, cfg['authType'], cfg, self.access.scopes)
        self._after_begin(cfg)

    def endGlobal(self) -> None:
        self.auth = None
        self.access = None
        self.cfg = None
