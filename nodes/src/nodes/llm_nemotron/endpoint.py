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
Endpoint classification shared by the runtime key guard and save-time validation.
"""

from urllib.parse import urlsplit

NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'

# NVIDIA's hosted inference lives under api.nvidia.com: integrate.api.nvidia.com
# for the OpenAI-compatible surface, ai.api.nvidia.com for some NIM routes.
_NVIDIA_CLOUD_DOMAIN = 'api.nvidia.com'


def is_nvidia_cloud_endpoint(serverbase: str | None) -> bool:
    """Return True when ``serverbase`` points at NVIDIA's hosted API.

    Decides by the parsed hostname, not a substring: a self-hosted NIM whose
    URL merely mentions ``api.nvidia.com`` in a path or query is not cloud,
    and ``api.nvidia.com.example`` is not NVIDIA. A bare host without a
    scheme (``integrate.api.nvidia.com/v1``) still parses.

    Args:
        serverbase: OpenAI-compatible base URL from the node config

    Returns:
        bool
    """
    if not serverbase:
        return False
    value = serverbase.strip()
    if '//' not in value:
        value = '//' + value
    try:
        host = urlsplit(value).hostname or ''
    except ValueError:
        return False
    host = host.lower().rstrip('.')
    return host == _NVIDIA_CLOUD_DOMAIN or host.endswith('.' + _NVIDIA_CLOUD_DOMAIN)
