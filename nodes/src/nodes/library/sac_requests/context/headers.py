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

"""Prepare the Http Request Headers to be sent along with the request.

It can create new headers as well as update the existing headers.
"""

from typing import Any, Dict, Optional

from ..constants.messages import INVALID_HEADER_FORMAT


class HttpHeaders:
    """Prepare headers to add to the Http request."""

    def __init__(self, headers: Dict[str, Any]):
        """Initialize the request header.

        :param headers: Request Headers
        :type headers: Dict[str, Any]
        """
        if not headers:
            headers = {}
        if not isinstance(headers, dict):
            raise ValueError(INVALID_HEADER_FORMAT)
        self._headers = headers

    @property
    def headers(self) -> Dict[str, Any]:
        """Get request headers.

        :return: Request headers
        :rtype: Dict[str, Any]
        """
        return self._headers

    @headers.setter
    def headers(self, headers_: Dict[str, Any]) -> None:
        """Set request headers.

        :param headers_: Request Headers
        :type headers_: Dict[str, Any]
        """
        if not headers_:
            headers_ = {}
        self._headers = headers_

    def update(self, headers: Optional[Dict[str, Any]]) -> None:
        """Update the request headers with the new headers.

        It will update the headers which are already present and
        add the headers which did not exists before.

        :param headers: Request Headers to be added
        :type headers: Optional[Dict[str, Any]]
        :raises ValueError: The headers dictionar
        """
        if not headers:
            headers = {}
        if not isinstance(headers, dict):
            raise ValueError(INVALID_HEADER_FORMAT)
        self._headers.update(headers)

    def get(self) -> Dict[str, Any]:
        """Get Http Request Header in key-value pair.

        :return: Http request headers
        :rtype: Dict[str, Any]
        """
        return self.headers
