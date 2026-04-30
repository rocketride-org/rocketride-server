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

"""Request configurations to use while sending the request over HTTP/HTTPS."""

from typing import Any

from ..constants.defaults import (
    DEFAULT_AUTH_TYPE,
    DEFAULT_MAX_RETRY,
    DEFAULT_RETRY_INTERVAL,
    DEFAULT_STATUS_FORCE_LIST,
    DEFAULT_TIMEOUT,
    DEFAULT_VERIFY,
)
from ..constants.general import AUTH_TYPE, MAX_RETRY, RETRY_INTERVAL, STATUS_FORCE_LIST, TIMEOUT, VERIFY


class HttpConfig:  # pylint: disable=too-few-public-methods
    """Http Request configurations Holder."""

    def __init__(self, **kwargs: Any) -> None:
        """Initialize the Http Request configurations.

        The configurations include:
        1. Timeout
        2. Retry Interval
        3. Response Status for which to force retry
        4. Maximum retry attempts to make.
        5. Authentication types
        6. Verify SSL

        :param kwargs: All configuration params passed as an
        http request initialization.
        """
        self.timeout = kwargs.pop(TIMEOUT, DEFAULT_TIMEOUT)
        self.retry_interval = kwargs.pop(RETRY_INTERVAL, DEFAULT_RETRY_INTERVAL)
        self.status_force_list = kwargs.pop(STATUS_FORCE_LIST, DEFAULT_STATUS_FORCE_LIST)
        self.max_retry = kwargs.pop(MAX_RETRY, DEFAULT_MAX_RETRY)
        self.auth_type = kwargs.pop(AUTH_TYPE, DEFAULT_AUTH_TYPE)
        self.verify = kwargs.pop(VERIFY, DEFAULT_VERIFY)
