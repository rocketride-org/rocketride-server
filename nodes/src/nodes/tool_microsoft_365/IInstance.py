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
Shared instance helpers for the Microsoft 365 tool services.

Each service subpackage subclasses :class:`MicrosoftToolInstanceBase`, sets
``SERVICE``, and gets the shared auth/access accessors, the common argument
validators, and the ``check_connection`` implementation. The decorated
``@tool_function check_connection`` itself stays in each service (its schema
and description are per-service); it delegates to
:meth:`_check_connection_impl`, optionally supplying a live probe.
"""

from __future__ import annotations

from typing import Any, Callable

from ai.common.config import Config
from rocketlib import IInstanceBase

from .graph_client import GraphService, token_scope_report


class MicrosoftToolInstanceBase(IInstanceBase):
    SERVICE: GraphService  # set by each service subclass

    # -----------------------------------------------------------------------
    # Shared accessors
    # -----------------------------------------------------------------------

    def _auth(self):
        """Return the shared Graph auth credential handle."""
        return self.IGlobal.auth

    def _access(self):
        """Return the node's access descriptor (tier, scopes, flags)."""
        return self.IGlobal.access

    # -----------------------------------------------------------------------
    # Shared argument validators (string/int validators come from
    # ai.common.utils.tool_args; only the ones it lacks live here)
    # -----------------------------------------------------------------------

    @staticmethod
    def _enum_arg(args: dict, key: str, allowed: tuple, default: str | None) -> str | None:
        """Read an optional enum arg, defaulting on absence and rejecting unknown values."""
        value = args.get(key)
        if value is None or value == '':
            return default
        if value not in allowed:
            raise ValueError(f'{key} must be one of {list(allowed)}, got {value!r}')
        return value

    # -----------------------------------------------------------------------
    # check_connection implementation (each service exposes the decorated tool)
    # -----------------------------------------------------------------------

    def _check_connection_impl(self, probe: 'Callable[[Any], None] | None' = None) -> dict:
        """Diagnostics: auth present, optional live probe, scope coverage.

        ``probe``: a cheap real API call taking the auth handle; when it
        raises, connection_ok flips false and the error is reported. A
        malformed user token likewise reports connection_ok=False rather than
        being swallowed — this tool exists precisely for the broken cases.
        """
        access = self._access()
        out: dict = {
            'connection_ok': self._auth() is not None,
            'access': getattr(access, 'tier', None),
            'requiredScopes': list(getattr(access, 'scopes', []) or []),
        }
        auth = self._auth()
        if probe is not None and auth is not None:
            try:
                probe(auth)
            except Exception as exc:
                out['connection_ok'] = False
                out['error'] = str(exc)[:200]
        try:
            cfg = Config.getNodeConfig(self.IGlobal.glb.logicalType, self.IGlobal.glb.connConfig)
            auth_type = (cfg.get('authType') or 'service').strip()
            out['authType'] = auth_type
            if auth_type == 'user':
                token_str = str(cfg.get('userToken') or '').strip()
                if token_str:
                    try:
                        _granted, covered, missing = token_scope_report(self.SERVICE, cfg, out['requiredScopes'])
                        out['connection_ok'] = out['connection_ok'] and covered
                        if not covered:
                            out['missingScopes'] = missing
                    except Exception as exc:
                        out['connection_ok'] = False
                        out['error'] = f'invalid user token data: {str(exc)[:160]}'
        except Exception:
            pass  # config lookup diagnostics must never raise
        return out
