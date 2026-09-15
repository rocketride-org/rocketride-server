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
Shared instance helpers for the Google Workspace tool services.

Each service subpackage subclasses :class:`GoogleToolInstanceBase`, sets
``SERVICE``, and gets the shared service/access accessors, the common argument
validators, and the ``check_connection`` implementation. The decorated
``@tool_function check_connection`` itself stays in each service (its schema
and description are per-service); it delegates to
:meth:`_check_connection_impl`, optionally supplying a live probe.
"""

from __future__ import annotations

from typing import Any, Callable

from ai.common.config import Config
from rocketlib import IInstanceBase

from .google_client import GoogleService, token_scope_report


class GoogleToolInstanceBase(IInstanceBase):
    SERVICE: GoogleService  # set by each service subclass

    # -----------------------------------------------------------------------
    # Shared accessors
    # -----------------------------------------------------------------------

    def _svc(self):
        """Return the shared discovery service handle."""
        return self.IGlobal.service

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
        """Diagnostics: service present, optional live probe, scope coverage.

        ``probe``: a cheap real API call taking the service handle; when it
        raises, connection_ok flips false and the error (plus, when Google
        supplies one, the structured reason code — accessNotConfigured,
        forbidden, rateLimitExceeded, ...) is reported. A malformed user
        token likewise reports connection_ok=False rather than being
        swallowed — this tool exists precisely for the broken cases.

        Without a probe, nothing here ever calls Google, so a client that
        constructs fine and a token whose claimed scopes look right can both
        be true while every real call 403s (e.g. the API is disabled on the
        project behind the credential). That state is reported as
        connection_ok='unknown', not True — a green light nobody verified is
        worse than no light, because it sends debugging effort everywhere
        except the actual cause.
        """
        access = self._access()
        service = self._svc()
        checked = ['client']
        if service is None:
            connection_ok: bool | str = False
        elif probe is None:
            connection_ok = 'unknown'
        else:
            connection_ok = True
        out: dict = {
            'connection_ok': connection_ok,
            'access': getattr(access, 'tier', None),
            'requiredScopes': list(getattr(access, 'scopes', []) or []),
        }
        if probe is not None and service is not None:
            checked.append('probe')
            try:
                probe(service)
            except Exception as exc:
                out['connection_ok'] = False
                # Generous cap: the actionable guidance (scope/sharing/accessNotConfigured
                # hints) trails the raw Google message, and errorReason below is the
                # machine-readable fallback, but a human reading just `error` should still
                # see the clause that names the fix rather than have it cut mid-sentence.
                out['error'] = str(exc)[:500]
                reason_code = getattr(exc, 'reason_code', None)
                if reason_code:
                    out['errorReason'] = reason_code
        try:
            cfg = Config.getNodeConfig(self.IGlobal.glb.logicalType, self.IGlobal.glb.connConfig)
            auth_type = (cfg.get('authType') or 'service').strip()
            out['authType'] = auth_type
            if auth_type == 'user':
                token_str = str(cfg.get('userToken') or '').strip()
                if token_str:
                    checked.append('scopes')
                    try:
                        _granted, covered, missing = token_scope_report(self.SERVICE, cfg, out['requiredScopes'])
                        if not covered:
                            out['connection_ok'] = False
                            out['missingScopes'] = missing
                    except Exception as exc:
                        out['connection_ok'] = False
                        # A separate key: 'error' may already hold the probe's failure
                        # (checked above the scope check), and overwriting it here would
                        # lose that message.
                        out['scopeError'] = f'invalid user token data: {str(exc)[:160]}'
        except Exception:
            pass  # config lookup diagnostics must never raise
        out['checked'] = checked
        return out
