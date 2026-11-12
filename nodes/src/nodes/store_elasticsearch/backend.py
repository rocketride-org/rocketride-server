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

"""Backend selection and host normalisation shared by the global and the validator (import-light)."""

from typing import Any

from .constants import BACKEND_ELASTICSEARCH, BACKEND_OPENSEARCH


def resolve_backend(logical_type: Any) -> str:
    """The backend of a registration: the opensearch service, else Elasticsearch."""
    return BACKEND_OPENSEARCH if 'opensearch' in str(logical_type).lower() else BACKEND_ELASTICSEARCH


def normalize_opensearch_host(host: str, use_auth: bool) -> str:
    """Ensure the host has a scheme; upgrade to https when auth is enabled."""
    host = (host or '').strip()
    if '://' not in host:
        host = f'http://{host}'
    if use_auth and host.startswith('http://'):
        host = 'https://' + host[len('http://') :]
    return host
