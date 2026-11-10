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

"""Which endpoint a DeepSeek branch's serverbase points at.

Shared by the client (key requirement) and the validator (probe routing), so it
stays stdlib-only: the validator is imported in CONFIG mode.
"""

from urllib.parse import urlparse

#: The host of the DeepSeek API, the only endpoint the API key belongs to.
DEEPSEEK_API_HOST = 'api.deepseek.com'


def is_deepseek_api(serverbase: str) -> bool:
    """
    Return True when ``serverbase`` is the DeepSeek API, judged by its host name.

    A local server whose path or query happens to carry ``api.deepseek``
    (``http://ollama.lan/api.deepseek/v1``) is not the API.

    Args:
        serverbase: The resolved branch serverbase URL.
    """
    # Stripped here so the client (which strips before building) and the
    # validator judge a padded URL the same way
    host = (urlparse((serverbase or '').strip()).hostname or '').lower()
    return host == DEEPSEEK_API_HOST or host.endswith('.' + DEEPSEEK_API_HOST)
