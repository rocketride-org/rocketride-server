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

"""Whether a GLM branch's serverbase points at the Z.ai / Zhipu cloud API.

Shared by the client (key requirement) and the validator (probe routing), so it
stays stdlib-only: the validator is imported in CONFIG mode.
"""

from urllib.parse import urlparse

#: The cloud API domains: api.z.ai (international) and bigmodel.cn (mainland
#: China, served from open.bigmodel.cn).
GLM_CLOUD_DOMAINS = ('api.z.ai', 'bigmodel.cn')


def is_glm_cloud_api(serverbase: str) -> bool:
    """
    Return True when ``serverbase`` is the Z.ai / Zhipu cloud API, judged by its host name.

    A local server whose path or query happens to carry ``api.z.ai``
    (``http://vllm.lan/api.z.ai/v1``) is not the API.

    Args:
        serverbase: The resolved branch serverbase URL.
    """
    # Stripped here so the client and the validator judge a padded URL the same way
    host = (urlparse((serverbase or '').strip()).hostname or '').lower()
    return any(host == domain or host.endswith('.' + domain) for domain in GLM_CLOUD_DOMAINS)
