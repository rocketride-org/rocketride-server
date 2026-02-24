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

"""General purpose unitilities."""

import json
import re
from typing import Tuple
from urllib.parse import urlparse

import requests  # type: ignore
from requests.models import Response  # type: ignore

from ..constants.defaults import DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT
from ..constants.general import HTTP, HTTPS


def clean_endpoint(endpoint: str) -> str:
    """Clean the endpoint to make it ready to concatinate with URL.

    Adds a '/' at the start of the endpoint if it is absent
    Removes any number of occurances of '/' at the end of the endpoint.

    :param endpoint: Endpoint to be cleaned
    :type endpoint: str
    :return: Cleaned endpoint
    :rtype: str
    """
    endpoint_rgx = r'(\/)+$'

    if not endpoint.startswith('/'):
        # Endpoint does not start with forward slash
        endpoint = f'/{endpoint}'

    if endpoint.endswith('/'):
        # Endpoint ends with forward slash
        endpoint = re.sub(endpoint_rgx, '', endpoint)

    return endpoint


def get_url_components(url: str) -> Tuple[str, str, int, str]:
    """Get the url components from the url.

    Retrieves URL scheme, hostname, port and path (including query params)

    If the scheme is not supplied it will consider default HTTP.

    If the port is not present, it will assume 80 as a default

    :param url: URL to split in components
    :type url: str
    :return: URL scheme, hostname, port and path
    :rtype: Tuple[str, str, int, str]
    """
    default_ports = {HTTP: DEFAULT_HTTP_PORT, HTTPS: DEFAULT_HTTPS_PORT}

    components = urlparse(url, scheme=HTTP)

    # Get the port number
    scheme = components.scheme
    port = components.port or default_ports.get(scheme, DEFAULT_HTTP_PORT)

    # Get the Hostname
    host = components.hostname if components.hostname else ''

    # Get path along with the query parameters
    path = f'{components.path}'
    if components.query:
        path = f'{path}?{components.query}'

    return components.scheme, host, port, path  # type: ignore


def get_response_message(response: Response) -> str:
    """Get the message from the response object.

    :param response: Response received from the request
    :type response: Response
    :return: Response Message
    :rtype: str
    """
    message: str = ''
    try:
        content = response.json()
        message = json.dumps(content)
    except ValueError:
        """No need to process anything since the response is not in json."""
        pass
    return message


def get_err_response_code(err: requests.exceptions.RequestException) -> int:
    """Get the response status code from the HttpError.

    :param err: Request Error
    :type err: requests.exceptions.RequestException
    :return: Status code
    :rtype: int
    """
    status_code: int = 0
    if err.response is not None and err.response.status_code:
        status_code = err.response.status_code
    else:
        status_code = requests.codes.bad_request

    return status_code
