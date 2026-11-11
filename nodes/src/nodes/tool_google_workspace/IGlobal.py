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
Shared global lifecycle for the Google Workspace tool services.

Each service subpackage (gmail/, sheets/, docs/, calendar/, drive/) subclasses
:class:`GoogleToolGlobalBase`, sets ``SERVICE`` (its :class:`GoogleService`
profile) and ``SPEC_NAME`` (its AccessSpec in ``nodes.core.google_access``),
and inherits the whole beginGlobal / endGlobal lifecycle. Save-time
validation lives in the sibling ``IValidator`` modules. Service-specific
post-build state (e.g. drive's account-domain resolution) hooks in via
:meth:`_after_begin`.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

from rocketlib import IGlobalBase

from .google_client import GoogleService, access_spec, build_service


class GoogleToolGlobalBase(IGlobalBase):
    """Resolved access + built discovery service for one Workspace service."""

    SERVICE: GoogleService  # set by each service subclass
    SPEC_NAME: str = ''  # AccessSpec attribute name in nodes.core.google_access

    service: Any = None
    access: Any = None

    def _after_begin(self, cfg: Mapping) -> None:
        """Hook for service-specific post-build state (default: none)."""

    def beginGlobal(self) -> None:
        from depends import depends  # type: ignore

        # The shared requirements.txt lives at the tool_google_workspace/ level.
        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from nodes.core.google_access import resolve_google_access

        # The resolved view holds the active authType branch flattened beside the
        # gate flags (allowDelete, allowPublicSharing, allowHardDelete), which
        # _resolve_flags reads next to 'access'.
        cfg = self.config
        self.access = resolve_google_access(cfg, access_spec(self.SPEC_NAME))
        self.service = build_service(self.SERVICE, cfg['authType'], cfg, self.access.scopes)
        self._after_begin(cfg)

    def endGlobal(self) -> None:
        self.service = None
        self.access = None
