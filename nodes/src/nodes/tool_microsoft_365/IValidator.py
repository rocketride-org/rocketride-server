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
Shared save-time validation for the Microsoft 365 tool services.

Each service subpackage subclasses :class:`MicrosoftToolValidatorBase` in its
own ``IValidator.py``, sets ``SERVICE`` and ``SPEC_NAME``, and inherits the
whole check. The engine imports only this module in CONFIG mode, so it stays
import-light: the schema check is the resolver (``self.config``), the semantic
check decodes the user token and compares its scopes with the selected access
tier, or confirms the app registration fields are present.
"""

from __future__ import annotations

from rocketlib import IValidatorBase, warning

from .graph_client import GraphService, token_scope_report


class MicrosoftToolValidatorBase(IValidatorBase):
    """Scope coverage / credential presence check for one Microsoft 365 service."""

    SERVICE: GraphService  # set by each service subclass
    SPEC_NAME: str = ''  # AccessSpec attribute name in nodes.core.microsoft_access

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, its credential.

        Args:
            syntaxOnly (bool): True checks the shape only.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        cfg = self.config
        if syntaxOnly:
            return

        product = self.SERVICE.product
        try:
            from nodes.core import microsoft_access

            # Surfaces tier/flag misconfig (unknown tier, non-bool flag) as a warning.
            resolved = microsoft_access.resolve_microsoft_access(cfg, getattr(microsoft_access, self.SPEC_NAME))
            if cfg['authType'] == 'user':
                token_str = str(cfg.get('userAuth') or '').strip()
                if not token_str:
                    warning(f'{product}: sign in with Microsoft to provide an access token')
                else:
                    try:
                        _granted, covered, missing = token_scope_report(self.SERVICE, cfg, resolved.scopes)
                        if not covered:
                            warning(
                                f'{product}: your Microsoft account authorization is missing scopes '
                                'for the selected access tier. Please disconnect and reconnect '
                                f'your Microsoft account. Missing: {", ".join(missing)}'
                            )
                    except Exception as exc:
                        # A corrupt token must warn at config time, not surface later
                        # as a cryptic run-time failure.
                        warning(f'{product}: invalid user token data ({exc})')
            else:
                for key, title in (
                    ('tenantId', 'Tenant ID'),
                    ('clientId', 'Client ID'),
                    ('clientSecret', 'Client Secret'),
                    ('userPrincipalName', 'Acting User'),
                ):
                    if not str(cfg.get(key) or '').strip():
                        warning(f'{product}: {title} ({key}) is required for App authentication')
        except Exception as e:
            warning(str(e))
