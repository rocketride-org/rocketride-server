# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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

"""Http Request error exceptions."""

import requests  # type: ignore
from requests.exceptions import RequestException  # type: ignore


class HttpRequestError(RequestException, ConnectionError):
    """Exception to be raised when there is an error while sending a request.

    :param RequestException: Extensions Request Exception
    :type RequestException: type
    """

    def __init__(self, message: str, errcode: int = requests.codes.bad_request) -> None:  # pylint: disable=line-too-long
        """Initialise HttpRequestError.

        :param message: Error message
        :type message: str
        :param errcode: Error Code, defaults to requests.codes.bad_request (400)
        :type errcode: int, optional
        """
        super().__init__()
        self.errcode = errcode
        self.message = message

    def __str__(self) -> str:
        """Represent error as string.

        :return: Http Reqyest error when called by str function
        :rtype: str
        """
        return f'{self.__class__.__name__} [{self.errcode}]: {self.message}'

    def __repr__(self) -> str:
        """Raw object representation of the Error.

        :return: Raw representation of the http request error.
        :rtype: str
        """
        error = '<{name} category={cat} msg={msg}>'
        return error.format(name=self.__class__.__name__, cat=self.errcode, msg=self.message)
