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
and inherits the whole beginGlobal / validateConfig / endGlobal lifecycle.
Service-specific post-build state (e.g. drive's account-domain resolution)
hooks in via :meth:`_after_begin`.
"""

from __future__ import annotations

import os
from typing import Any

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .google_client import GoogleService, build_service, token_scope_report


class GoogleToolGlobalBase(IGlobalBase):
    """Resolved access + built discovery service for one Workspace service."""

    SERVICE: GoogleService  # set by each service subclass
    SPEC_NAME: str = ''  # AccessSpec attribute name in nodes.core.google_access

    service: Any = None
    access: Any = None

    def _spec(self):
        """Resolve this service's AccessSpec (deferred: engine-path import)."""
        from nodes.core import google_access

        return getattr(google_access, self.SPEC_NAME)

    def _after_begin(self, cfg: dict) -> None:
        """Hook for service-specific post-build state (default: none)."""

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        # The shared requirements.txt lives at the tool_google_workspace/ level.
        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from nodes.core.google_access import resolve_google_access

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        # Pass the full config: gate flags (allowDelete, allowPublicSharing,
        # allowHardDelete) live beside 'access' and must reach _resolve_flags.
        self.access = resolve_google_access(cfg, self._spec())
        auth_type = (cfg.get('authType') or 'service').strip()
        self.service = build_service(self.SERVICE, auth_type, cfg, self.access.scopes)
        self._after_begin(cfg)

    def validateConfig(self) -> None:
        product = self.SERVICE.product
        try:
            from nodes.core.google_access import resolve_google_access

            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            # Surfaces tier/flag misconfig (unknown tier, non-bool flag) as a warning.
            resolved = resolve_google_access(cfg, self._spec())
            auth_type = (cfg.get('authType') or 'service').strip()
            if auth_type == 'user':
                token_str = str(cfg.get('userToken') or '').strip()
                if not token_str:
                    warning(f'{product}: sign in with Google to provide an access token')
                else:
                    try:
                        _granted, covered, missing = token_scope_report(self.SERVICE, cfg, resolved.scopes)
                        if not covered:
                            warning(
                                f'{product}: your Google account authorization is missing scopes '
                                'for the selected access tier. Please disconnect and reconnect '
                                f'your Google account. Missing: {", ".join(missing)}'
                            )
                    except Exception as exc:
                        # A corrupt token must warn at config time, not surface later
                        # as a cryptic run-time failure.
                        warning(f'{product}: invalid user token data ({exc})')
            elif not str(cfg.get('serviceKey') or '').strip():
                warning(f'{product}: a service account key file is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.service = None
        self.access = None
