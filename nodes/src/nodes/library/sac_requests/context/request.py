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

"""Module contains the HttpRequest context to perform all the http request."""

import datetime
import logging
import time
from email.utils import parsedate_to_datetime
from typing import Any, Dict, Optional, Union, Callable

import urllib3.exceptions

import requests  # type: ignore
from requests.models import Response  # type: ignore

from ..constants.defaults import DEFAULT_EXP_MAX_RETRY
from ..constants.general import (
    AUTH,
    AUTHORIZATION,
    BASIC_AUTH,
    BEARER_TOKEN,
    DATA,
    DELETE,
    GET,
    HEAD,
    HEADERS,
    NO_AUTH,
    OPTIONS,
    PARAMS,
    PATCH,
    POST,
    PUT,
    REQ_LOGGER,
    RETRY_AFTER,
    URL,
)
from ..constants.messages import (
    BASIC_AUTH_PARAMS_MISSING,
    CONNECTION_ERROR,
    HTTP_ERROR,
    MISSING_AUTH_TOKEN,
    REQ_WAIT_TIME,
    REQ_ATTEMPT_EXCEEDED,
    REQUEST_ERROR,
    SSL_ERROR,
    TIMEOUT_ERROR,
    TOO_MANY_REQUESTS,
    INVALID_AUTH_TOKEN,
    UNKNOWN_AUTH_TYPE,
)
from .config import HttpConfig
from .endpoint import Endpoint
from .headers import HttpHeaders
from .session import set_request_session
from .url import HttpURL
from ..exceptions.base import HttpRequestError
from ..exceptions.connection import HttpRequestConnectionError
from ..exceptions.timeout import HttpRequestTimeoutError
from ..utils.general import get_err_response_code, get_response_message
from ..utils.validators import is_too_many_requests, is_access_denied


class HttpRequest:
    """Http Request wrapper to handle retries and timeouts."""

    def __init__(
        self,
        url: HttpURL,
        config: HttpConfig,
        headers: HttpHeaders,
        auth_type: str = NO_AUTH,
        refresh_headers: Callable[[], Dict[str, Any]] = None,
    ) -> None:
        """Initialise HTTP requests.

        :param url: Http Request URL
        :type url: str
        :param config: Configurations used in the request
        :type config: HttpConfig
        :param headers: Http Request Headers
        :type headers: HttpHeaders
        """
        if auth_type not in [NO_AUTH, BASIC_AUTH, BEARER_TOKEN]:
            raise ValueError(UNKNOWN_AUTH_TYPE)

        self._url = url
        self._auth_type = auth_type

        # Request Headers
        self._headers = headers

        self._refresh_headers = refresh_headers

        # Request configurations
        self._config = config

        # Request object
        self._session = set_request_session(config)

        # Set logger to None
        self._logger: Union[logging.Logger, None] = None

    @property
    def url(self) -> HttpURL:
        """Get URL for the http requests.

        :return: HTTP Request URL
        :rtype: URL
        """
        return self._url

    @url.setter
    def url(self, url: HttpURL) -> None:
        """Set URL for the http requests.

        :param url: HTTP Request URL
        :type url: URL
        """
        self._url = url

    @property
    def auth_type(self) -> str:
        """Get authentication type.

        :return: Authentication type
        :rtype: str
        """
        return self._auth_type

    @auth_type.setter
    def auth_type(self, auth_type_: str) -> None:
        """Set authnetication type.

        :param auth_type_: Authentication type
        :type auth_type_: str
        """
        self._auth_type = auth_type_

    @property
    def headers(self) -> HttpHeaders:
        """Get Http Request Headers.

        :return: Http Request Headers
        :rtype: HttpHeaders
        """
        return self._headers

    @headers.setter
    def headers(self, headers_: HttpHeaders) -> None:
        """Set Http Request Headers.

        :param headers_: Http Request Headers
        :type headers_: HttpHeaders
        """
        self._headers = headers_

    @property
    def session(self) -> requests.Session:
        """Get http request session object.

        :return: Request session object
        :rtype: requests.Session
        """
        return self._session

    @session.setter
    def session(self, http: requests.Session) -> None:
        """Set http/https session object.

        :param http: Request session object
        :type http: requests.Session
        """
        self._session = http

    @property
    def logger(self) -> logging.Logger:
        """Get logger for the request.

        :return: Request Logger
        :rtype: logging.Logger
        """
        if not self._logger:
            self._logger = logging.getLogger(__name__)
        return self._logger

    @logger.setter
    def logger(self, logger_: logging.Logger) -> None:
        """Set logger for the request.

        :param logger_: Request logger
        :type logger_: logging.Logger
        """
        self._logger = logger_

    def _validate_auth_headers(self, headers: Dict[str, Any], **kwargs: Any) -> None:  # pylint: disable=line-too-long
        """Validate the authentication parameters in headers.

        :param headers: Request headers supplied.
        :type headers: Dict[str, Any]
        :raises ValueError: If the Auth key does not exists in the parameters
        :raises ValueError: If the authentication token does not exists
            in the parameters.
        """
        if self.auth_type == BASIC_AUTH:
            if AUTH not in kwargs.keys():
                raise ValueError(BASIC_AUTH_PARAMS_MISSING)
        elif self.auth_type == BEARER_TOKEN:
            if AUTHORIZATION not in headers.keys():
                raise ValueError(MISSING_AUTH_TOKEN)
        else:
            # TODO: Other authentications methods will be handled.  # pylint: disable=fixme
            pass

    def _prepare(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Dict[str, Any]:  # pylint: disable=line-too-long
        """Prepare the request.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Prepared request with url, headers, data, and params
        :rtype: Dict[str, Any]
        """
        # Get the Request URL.
        _url = self.url.prepare(endpoint=Endpoint(endpoint))

        # Set the Headers
        self.headers.update(headers)
        headers = self.headers.get()

        self._validate_auth_headers(headers, **kwargs)

        # Get the logger passed in the request
        self.logger = kwargs.get(REQ_LOGGER, None)  # type: ignore

        # Add the request key-value pairs to the dictionary
        kwargs[URL] = _url  # type: ignore
        kwargs[HEADERS] = headers
        kwargs[DATA] = data  # type: ignore
        kwargs[PARAMS] = params  # type: ignore

        return kwargs

    def _is_wait_n_retry(self, headers: Dict[str, Any], count_all: int, count_throttling: int) -> bool:
        """Wait for sometime and retry the request.

        This checks if response header has Retry-After in it.

        Retry-After in response header:
            It will check if it is a http date or delay in seconds.

            1. Http Date: it will be converted to the timestamp and difference with current time is taken
            2. Delay in seconds: Consider this as a wait time in seconds

        No Retry-After in response header:
            Go for exponential backoff

        :param headers: _description_
        :type headers: Dict[str, Any]
        :param count_all: current attempt
        :type count_all: int
        :param count_throttling: current throttling attempt
        :type count_throttling: int
        :return: tuple of (status, count) where status is True if retry is possible else False, and count is the number of attempts made
        :rtype: tuple[bool, int]
        """
        wait: int = 0

        if RETRY_AFTER in headers and headers[RETRY_AFTER]:
            # Retry after is received in the response header
            if headers[RETRY_AFTER].isdigit():
                # It's a delay in seconds
                wait = int(headers[RETRY_AFTER])
            else:
                # It's http date
                try:
                    retry_after = parsedate_to_datetime(headers[RETRY_AFTER]).timestamp()
                    now = datetime.datetime.now().timestamp()
                    # Get the wait time from the difference of current time and retry after datetime
                    wait = int(retry_after - now)
                except TypeError:
                    wait = int(self._config.max_retry)
        else:
            # retry after is not present in response header
            # do exponential backoff, but limit it to 10 minutes
            wait = min(600, self._config.retry_interval * (2**count_all))

        # wait only if not reached the limit of max retry
        count_not_throttling = count_all - count_throttling
        if count_not_throttling < self._config.max_retry and count_not_throttling < DEFAULT_EXP_MAX_RETRY:
            count_all += 1
            self.logger.warning(REQ_WAIT_TIME.format(sec=wait, count=count_all, count_throttling=count_throttling))  # pylint: disable=logging-format-interpolation
            # Sleep corresponding time
            time.sleep(wait)
            # return True to retry the request
            return True, count_all

        # Stop sending the request if maximum number of non-throttling retries are done.
        # It should be total max retries configured
        self.logger.warning(REQ_ATTEMPT_EXCEEDED.format(count=count_all, count_throttling=count_throttling))  # pylint: disable=logging-format-interpolation
        return False, count_all

    def _request(self, method: str, **kwargs: Dict[str, Any]) -> Response:
        """Send the request to the configured url over a method.

        :param method: Http request method
        :type method: str
        :return: Reponse received from the URL endpoint
        :rtype: Response
        """
        status = True
        count_all = 0  # Total number of attempts made to send the request
        count_throttling = 0  # Total number of attempts made to send the request excluding throttling
        while status:
            if self._refresh_headers:
                headers = self._refresh_headers()
                self.headers.update(headers)
                headers = self.headers.get()
                kwargs[HEADERS] = headers

            _request = getattr(self.session, method)
            response: Response = _request(**kwargs)
            self.close()

            # retry in case
            #   - too many requests
            #   - access is denied and refresh headers is set ...
            #       access might be denied in this case if requests library received too many requests internally,
            #       and resend the requests internally, and this way the token expired...
            # 1st stage - prepare message if response is 429 or 401
            msg = None
            if is_too_many_requests(response.status_code):
                # The server responded with status 429 (too many requests)
                count_throttling += 1
                msg = TOO_MANY_REQUESTS.format(url=kwargs[URL], code=response.status_code, err=response.text)
            elif self._refresh_headers and is_access_denied(response.status_code):
                # The server responded with status 401 (access denied), and refresh headers is set
                msg = INVALID_AUTH_TOKEN
            else:
                # The server responded with status other than 429 and 401
                status = False

            # 2nd stage - wait and retry if message is set
            if msg:
                self.logger.warning(msg)
                status, count_all = self._is_wait_n_retry(response.headers, count_all, count_throttling)

        return response

    def _send(self, method: str, **kwargs: Dict[str, Any]) -> Response:
        """Send request to the URL supplied over the method.

        :param method: Request method to be called, like get, post, etc.
        :type method: str
        :raises HttpRequestError: Http request error occured
        :raises HttpRequestConnectionError: Connection error occured
        :raises HttpRequestTimeoutError: Request timed out
        :raises HttpRequestError: SSL related error occcured
        :raises HttpRequestError: Other error occured while sending request.
        :return: Response recieved from the URL endpoint.
        :rtype: Response
        """
        response: Any = None
        try:
            response = self._request(method, **kwargs)

            # Assert that there were no errors
            response.raise_for_status()
        except requests.exceptions.HTTPError as err:
            content = get_response_message(response) if response is not None else ''
            err_msg = content if content else str(err)
            msg = HTTP_ERROR.format(url=kwargs[URL], msg=err_msg)
            ecd = get_err_response_code(err)
            raise HttpRequestError(message=msg, errcode=ecd) from err
        except requests.exceptions.SSLError as err:
            msg = SSL_ERROR.format(url=kwargs[URL], msg=str(err))
            ecd = get_err_response_code(err)
            raise HttpRequestError(message=msg, errcode=ecd) from err
        except requests.exceptions.ConnectionError as err:
            msg = CONNECTION_ERROR.format(url=kwargs[URL], msg=str(err))
            ecd = get_err_response_code(err)
            raise HttpRequestConnectionError(msg, ecd) from err
        except requests.exceptions.Timeout as err:
            msg = TIMEOUT_ERROR.format(url=kwargs[URL], msg=str(err))
            ecd = get_err_response_code(err)
            raise HttpRequestTimeoutError(msg, ecd) from err
        except requests.exceptions.RequestException as err:
            msg = REQUEST_ERROR.format(url=kwargs[URL], msg=str(err))
            ecd = get_err_response_code(err)
            raise HttpRequestError(message=msg, errcode=ecd) from err
        # APPLAT-5773:
        # Requests lib does not handle urllib3 InvalidChunkLength exceptions
        # (see /python/lib/requests/adapters.py).
        # So we need a separate urllib3 InvalidChunkLength exception handler
        except urllib3.exceptions.InvalidChunkLength as err:
            msg = REQUEST_ERROR.format(url=kwargs[URL], msg=str(err))
            ecd = err.response.status
            raise HttpRequestError(message=msg, errcode=ecd) from err
        except Exception as err:
            msg = REQUEST_ERROR.format(url=kwargs[URL], msg=str(err))
            ecd = requests.codes.bad_request
            raise HttpRequestError(message=msg, errcode=ecd) from err
        return response

    def close(self) -> None:
        """Close http connection."""
        self.session.close()

    def get(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Response:
        """Send get request with headers and query parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, data, params, **kwargs)

        # Send the get request
        return self._send(GET, **kwargs)

    def head(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Response:
        """Send head request with headers, data, and parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, data, params, **kwargs)

        # Send the head request
        return self._send(HEAD, **kwargs)

    def post(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Response:
        """Send post request with headers, data, and parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, data, params, **kwargs)

        # Send the post request
        return self._send(POST, **kwargs)

    def put(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Response:
        """Send put request with headers and query parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, data, params, **kwargs)

        # Send the put request
        return self._send(PUT, **kwargs)

    def delete(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Response:
        """Send delete request with headers and query parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, data, params, **kwargs)

        # Send the delete request
        return self._send(DELETE, **kwargs)

    def patch(
        self,
        endpoint: str,
        headers: Optional[Dict[str, Any]] = None,
        data: Optional[Dict[str, Any]] = None,
        params: Optional[Dict[str, Any]] = None,
        **kwargs: Dict[str, Any],
    ) -> Response:
        """Send patch request with headers, data, and parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, data, params, **kwargs)

        # Send the patch request
        return self._send(PATCH, **kwargs)

    def options(self, endpoint: str, headers: Optional[Dict[str, Any]] = None, **kwargs: Any) -> Response:
        """Send options request with headers and query parameters.

        :param endpoint: Endpoint to which the request is to be sent
        :type endpoint: str
        :param headers: Headers to be included in the request, defaults to None
        :type headers: Optional[Dict[str, Any]], optional
        :param data: Data to be sent in the payload, defaults to None
        :type data: Optional[Dict[str, Any]], optional
        :param params: Query parameters to be sent in the request, defaults to None
        :type params: Optional[Dict[str, Any]], optional
        :return: Response received from the request
        :rtype: Response
        """
        # Prepare the request
        kwargs = self._prepare(endpoint, headers, **kwargs)

        # Send the options request
        return self._send(OPTIONS, **kwargs)
