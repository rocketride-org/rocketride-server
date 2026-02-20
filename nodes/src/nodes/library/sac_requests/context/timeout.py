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

"""Prepare the timeout for http request, in case of server related issues."""

from typing import Any

from requests.adapters import HTTPAdapter  # type: ignore
from requests.models import Request  # type: ignore
from requests.models import Response

from ..constants.defaults import DEFAULT_TIMEOUT
from ..constants.general import TIMEOUT


class TimeoutHTTPAdapter(
    HTTPAdapter  # type: ignore
):  # pylint: disable=too-few-public-methods
    """Transport Adapter with default timeouts for http request.

    :param HTTPAdapter: The built-in HTTP Adapter for urllib3.
    :type HTTPAdapter: HTTPAdapter
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Initialise Timeout http adapter."""
        self.timeout = DEFAULT_TIMEOUT
        if TIMEOUT in kwargs:
            self.timeout = kwargs[TIMEOUT]
            del kwargs[TIMEOUT]
        super().__init__(*args, **kwargs)

    def send(self, request: Request, **kwargs: Any) -> Response:
        """Http request send method.

        :param request: Request object
        :type request: Any
        :return: Http request's response.
        :rtype: Response
        """
        timeout = kwargs.get(TIMEOUT)
        if timeout is None:
            kwargs[TIMEOUT] = self.timeout
        return super().send(request, **kwargs)
