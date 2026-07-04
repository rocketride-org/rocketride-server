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
Gmail tool node — global (shared) state.

Resolves the access tier + gate flags via the shared GMAIL spec, then builds a
Gmail v1 service (service-account or user OAuth) scoped to the granted scopes.
"""

from __future__ import annotations

import os
from typing import Any

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


class IGlobal(IGlobalBase):
    """Global state for tool_gmail: resolved access + built Gmail service."""

    service: Any = None
    access: Any = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from nodes.core.google_access import GMAIL, resolve_google_access

        from .gmail_client import build_service

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        # Pass the full config: gate flags like allowHardDelete live beside
        # 'access' and must reach _resolve_flags or they silently stay False.
        self.access = resolve_google_access(cfg, GMAIL)
        auth_type = (cfg.get('authType') or 'service').strip()
        self.service = build_service(auth_type, cfg, self.access.scopes)

    def validateConfig(self) -> None:
        try:
            from nodes.core.google_access import GMAIL, resolve_google_access

            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            # Surfaces tier/flag misconfig (unknown tier, non-bool flag) as a warning.
            resolve_google_access(cfg, GMAIL)
            auth_type = (cfg.get('authType') or 'service').strip()
            if auth_type == 'user':
                token_str = str(cfg.get('userToken') or '').strip()
                if not token_str:
                    warning('Gmail: sign in with Google to provide an access token')
                else:
                    try:
                        from .gmail_client import _decode_blob
                        import json as _json

                        token_info = _json.loads(_decode_blob(token_str))
                        granted = set((token_info.get('scope') or '').split())
                        resolved = resolve_google_access(cfg, GMAIL)
                        _full = 'https://mail.google.com/'
                        missing = [] if _full in granted else [s for s in resolved.scopes if s not in granted]
                        if missing and granted:
                            warning(
                                'Gmail: your Google account authorization is missing scopes '
                                'for the selected access tier. Please disconnect and reconnect '
                                f'your Google account. Missing: {", ".join(missing)}'
                            )
                    except Exception:
                        pass  # scope check must not block config validation
            elif not str(cfg.get('serviceKey') or '').strip():
                warning('Gmail: a service account key file is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.service = None
        self.access = None
