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

"""Http Request wrapper to wrap the request creation process."""

from typing import Any, Dict, Optional

from requests.models import Response  # type: ignore

from .constants.general import DATA, ENDPOINT, HEADERS, REFRESH_HEADERS, PARAMS
from .context.config import HttpConfig
from .context.headers import HttpHeaders
from .context.request import HttpRequest
from .context.url import HttpURL
from .exceptions.base import HttpRequestError
from .utils.general import get_url_components


class HttpRequestWrapper:
    """Http Request wrapper for generating a HttpRequest object."""

    def __init__(self, url: str, **kwargs: Dict[str, Any]) -> None:
        """Initialise the HttpWrapper object.

        It accepts parameters like:
        1. URL
        2. Headers (Request headers)
        3. Request configurations like:
            a. Max Retries
            b. Retry interval
            c. Request Timeout.

        :param url: URL to which to send the request
        :type url: str
        """
        # Get the headers
        headers = kwargs.get(HEADERS, {})
        if headers is None:
            headers = {}  # type: ignore
        self.headers = HttpHeaders(headers)

        self.refresh_headers = kwargs.get(REFRESH_HEADERS, None)

        # Get Http configurations.
        self.config = HttpConfig(**kwargs)

        # Set the protocol if it is not provided
        scheme, host, port, path = get_url_components(url)

        # Get endpoint
        self.endpoint = path

        # Get the URL
        self.url = HttpURL(protocol=scheme, host=host, port=port)

    def get(self) -> HttpRequest:
        """Get the Http Request object to be used to send the request.

        :return: Http request object
        :rtype: HttpRequest
        """
        return HttpRequest(self.url, self.config, self.headers, refresh_headers=self.refresh_headers)

    def send(
        self,
        method: str,
        endpoint: str = '',
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Optional[Dict[str, Any]],
    ) -> Response:  # pylint: disable=line-too-long,too-many-arguments
        """Send request to the endpoint with parameters and data supplied.

        kwargs can have:

            1. Extra request parameters required
            2. Logger to be used by request to log messages

        :param method: Http request method, e.g. get / post / etc.
        :type method: str
        :param endpoint: Endpoint to send requests to, defaults to ""
        :type endpoint: str, optional
        :param headers: Request headers, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Request data that needs to be sent, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Request parameters, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :raises ValueError: Request parameters are invalid
        :raises HttpRequestError: Some error occured during request processing.
        :return: Response received from the endpoint
        :rtype: Response
        """
        response: Any = None
        try:
            # Add the request key-value pairs to the dictionary
            kwargs[ENDPOINT] = endpoint if endpoint else self.endpoint  # type: ignore
            kwargs[HEADERS] = headers or {}
            kwargs[DATA] = data or {}
            kwargs[PARAMS] = params or {}

            # Get HttpRequest object
            http = self.get()
            # Get the request type
            request = getattr(http, method, http.get)
            # Send the request
            response = request(**kwargs)
        except ValueError as err:
            raise ValueError(str(err)) from err
        except HttpRequestError as err:
            raise err.__class__(message=err.message, errcode=err.errcode) from err  # pylint: disable=bad-exception-context

        return response
