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

import base64
import importlib.util
import json
from typing import Any, Callable, Optional, Tuple

# Default scope when callers omit one. Service-account credentials require an
# explicit scope set; without it google-auth leaves requires_scopes=True and
# client refresh fails. ADC also accepts this when passed to google.auth.default.
_DEFAULT_SCOPES = ['https://www.googleapis.com/auth/cloud-platform']


class GCPAuthError(Exception):
    """Raised when GCP authentication fails or config is invalid."""

    pass


def _missing_google_auth() -> GCPAuthError:
    return GCPAuthError("google-auth library is not installed. Ensure node requirements include 'google-auth'.")


def get_gcp_credentials(config: dict, scopes: Optional[list[str]] = None) -> Tuple[Any, Optional[str]]:
    """
    Resolves GCP credentials from the given node configuration.

    Returns:
        tuple[google.auth.credentials.Credentials, str]: The credentials and the resolved project ID.

    Raises:
        GCPAuthError: If configuration is invalid or missing.
    """
    resolved_scopes = list(scopes) if scopes else list(_DEFAULT_SCOPES)
    auth_type = config.get('authType', 'adc')
    project_id = config.get('projectId')

    if auth_type == 'service_account':
        key_data = config.get('serviceAccountKey')
        if not key_data:
            raise GCPAuthError("Service Account JSON key is required when authType is 'service_account', but missing.")

        # RocketRide UI usually uploads files as base64 data-url: data:application/json;base64,...
        try:
            if key_data.startswith('data:'):
                _, b64_data = key_data.split(',', 1)
                json_bytes = base64.b64decode(b64_data)
                key_info = json.loads(json_bytes.decode('utf-8'))
            else:
                # Fallback if raw JSON string is passed directly
                key_info = json.loads(key_data)
        except Exception as e:
            raise GCPAuthError(f'Failed to parse Service Account JSON key: {e}')

        try:
            from google.oauth2 import service_account
        except ImportError:
            raise _missing_google_auth()

        try:
            creds = service_account.Credentials.from_service_account_info(key_info)
            creds = creds.with_scopes(resolved_scopes)
        except Exception as e:
            raise GCPAuthError(f'Invalid Service Account format: {e}')

        if not project_id:
            project_id = key_info.get('project_id')

        return creds, project_id

    elif auth_type == 'adc':
        try:
            import google.auth
        except ImportError:
            raise _missing_google_auth()
        try:
            creds, default_project_id = google.auth.default(scopes=resolved_scopes)
            if not project_id:
                project_id = default_project_id
            return creds, project_id
        except Exception as e:
            raise GCPAuthError(f'Failed to acquire Application Default Credentials: {e}')

    else:
        raise GCPAuthError(f'Unknown authType: {auth_type}')


def google_auth_available() -> bool:
    """
    True when google-auth can be imported.

    A missing ``google`` parent package makes ``find_spec`` raise rather than
    return None, so both are "absent".
    """
    try:
        return importlib.util.find_spec('google.auth') is not None
    except (ModuleNotFoundError, ValueError):
        return False


def check_credentials_at_save_time(config: Any, scopes: list, report: Callable[[str], None]) -> None:
    """
    The save-time credential check shared by the GCP validators.

    Builds the configured credentials once and reports problems through
    ``report`` (a node's ``warning``); never raises, the user is still editing.
    CONFIG mode installs no node requirements, so an absent google-auth is a
    skipped check, said as such, rather than a credential error.

    Args:
        config: The resolved node config (authType, serviceAccountKey, projectId).
        scopes: The OAuth scopes the node needs.
        report: Where a problem is written, one message per call.
    """
    if not google_auth_available():
        report(
            'Credential check skipped: google-auth is not installed yet. '
            'It runs once the node has started and installed its requirements.'
        )
        return
    try:
        get_gcp_credentials(config, scopes=scopes)
    except GCPAuthError as e:
        report(f'Auth configuration error: {e}')
    except Exception as e:
        report(str(e))
