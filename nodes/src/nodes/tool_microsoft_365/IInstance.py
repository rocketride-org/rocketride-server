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

from rocketlib import IInstanceBase

from .graph_client import GraphService, require_token_scopes, token_scope_report


class MicrosoftToolInstanceBase(IInstanceBase):
    SERVICE: GraphService  # set by each service subclass

    # -----------------------------------------------------------------------
    # Shared accessors
    # -----------------------------------------------------------------------

    def _auth(self):
        """
        Return the control's Graph auth, once this call's tier is known to be granted.

        A user grant must carry the scopes of the tier the call asks for; the
        check runs once per binding, on the call's first Graph request.
        """
        if not self.__dict__.get('_graph_scopes_checked'):
            settings = self.settings
            if settings['authType'] == 'user':
                require_token_scopes(self.SERVICE, settings, self._access().scopes)
            self.__dict__['_graph_scopes_checked'] = True
        return self.IGlobal.auth

    def _access(self):
        """Return this call's access descriptor (tier, scopes, flags), resolved once per binding."""
        access = self.__dict__.get('_graph_access')
        if access is None:
            from nodes.core.microsoft_access import resolve_microsoft_access

            access = resolve_microsoft_access(self.settings, self.IGlobal.spec)
            self.__dict__['_graph_access'] = access
        return access

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
        # The diagnostic reports a missing scope below rather than refusing on it
        auth = self.IGlobal.auth
        out: dict = {
            'connection_ok': auth is not None,
            'access': getattr(access, 'tier', None),
            'requiredScopes': list(getattr(access, 'scopes', []) or []),
        }
        if probe is not None and auth is not None:
            try:
                probe(auth)
            except Exception as exc:
                out['connection_ok'] = False
                out['error'] = str(exc)[:200]
        try:
            # The resolved config for this call: the active authType branch flattened in
            cfg = self.settings
            auth_type = cfg['authType']
            out['authType'] = auth_type
            if auth_type == 'user':
                token_str = str(cfg.get('userAuth') or '').strip()
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
