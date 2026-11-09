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
Google Cloud Storage save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check builds the Google
credentials from the selected authentication branch so a missing or malformed
service-account key is reported while the user is still editing the node. The
Google auth helper is imported inside the check so this module stays
import-light.
"""

import importlib.util

from rocketlib import IValidatorBase, warning

_GCS_SCOPES = ['https://www.googleapis.com/auth/devstorage.read_only']


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the credential check."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, build the credentials.

        Args:
            syntaxOnly (bool): True checks the shape only; no credential parsing.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return

        # CONFIG mode installs no node requirements; google-auth arrives with
        # the node's first start. The helper wraps that ImportError as an auth
        # error, so test for the library first and say what really happened
        if importlib.util.find_spec('google.auth') is None:
            warning(
                'Credential check skipped: google-auth is not installed yet. '
                'It runs once the node has started and installed its requirements.'
            )
            return

        from nodes.core.gcp_auth import GCPAuthError, get_gcp_credentials

        try:
            get_gcp_credentials(config, scopes=_GCS_SCOPES)
        except GCPAuthError as e:
            warning(f'Auth configuration error: {e}')
        except Exception as e:
            warning(str(e))
