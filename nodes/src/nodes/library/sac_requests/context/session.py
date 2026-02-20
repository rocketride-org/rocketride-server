# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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

"""Module contains the helper function for the sac requests context."""

import requests  # type: ignore
from requests.packages.urllib3.util.retry import Retry  # type: ignore

from ..adapters.timeout import TimeoutHTTPAdapter
from ..constants.general import HTTP, HTTPS
from .config import HttpConfig


def set_request_session(config: HttpConfig) -> requests.Session:
    """Set request session with timeout and retry.

    :param config: Request configurations with retry and timeout configurations.
    :type config: HttpConfig
    :return: Request session object with retry and timeout configurations.
    :rtype: requests.Session
    """
    http = requests.Session()
    http.verify = config.verify

    # Retry configurations
    retries = Retry(
        total=config.max_retry,
        backoff_factor=config.retry_interval,
        status_forcelist=config.status_force_list,
    )
    adapter = TimeoutHTTPAdapter(timeout=config.timeout, max_retries=retries)
    # Mount it for both http and https usage
    http.mount(f'{HTTPS}://', adapter)
    http.mount(f'{HTTP}://', adapter)

    return http
