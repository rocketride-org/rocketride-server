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

The credential (``authType`` and its branch) is the control's. The access
tier and the gate flags are per-call parameters: a service-account token is
minted per scope set, so the control keeps one discovery service per tier,
built on the first call that asks for it. The spec bounds the cache (two
tiers for most services, six for Gmail).
"""

from __future__ import annotations

import os
import threading
from typing import Any, Dict, Mapping

from rocketlib import IGlobalBase

from .google_client import GoogleService, access_spec, build_service


class GoogleToolGlobalBase(IGlobalBase):
    """The control's credential and one discovery service per access tier a call has used."""

    SERVICE: GoogleService  # set by each service subclass
    SPEC_NAME: str = ''  # AccessSpec attribute name in nodes.core.google_access

    spec: Any = None

    def _after_begin(self, cfg: Mapping) -> None:
        """Hook for service-specific post-build state (default: none)."""

    def beginGlobal(self) -> None:
        from depends import depends  # type: ignore

        # The shared requirements.txt lives at the tool_google_workspace/ level.
        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        # The service's tiers; the services themselves are built per tier on first use
        self.spec = access_spec(self.SPEC_NAME)
        self._services: Dict[str, Any] = {}
        self._services_lock = threading.Lock()
        self._after_begin(self.config)

    def service_for(self, tier: str) -> Any:
        """
        The discovery service scoped to one access tier, built on first use.

        Args:
            tier: A tier of this service's AccessSpec (the call's resolved ``access``).

        Returns:
            The service whose credential carries that tier's scopes.
        """
        with self._services_lock:
            service = self._services.get(tier)
            if service is None:
                cfg = self.config
                service = build_service(self.SERVICE, cfg['authType'], cfg, self.spec.scopes[tier])
                self._services[tier] = service
            return service

    def endGlobal(self) -> None:
        self._services = {}
        self.spec = None
