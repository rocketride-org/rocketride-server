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

"""Preapre the URL for API Request.

A URL is generated from protocol, host and port (if supplied).

Also helps in preparing an endpoint for the API.
"""

from ..constants.defaults import DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT
from ..constants.general import HTTP, HTTPS
from .endpoint import Endpoint


class HttpURL:
    """Manage API URLs and get the valid endpoint."""

    def __init__(self, host: str, port: int = DEFAULT_HTTP_PORT, protocol: str = HTTP) -> None:
        """Initialise URL class object.

        :param host: URL Protocol
        :type host: str
        :param port: Host for the URL, defaults to 0
        :type port: int, optional
        :param protocol: Port for the URL, defaults to HTTP
        :type protocol: str, optional
        """
        self._protocol = protocol
        self._host = host
        # Set port value
        self._port = self._set_port(port)

        self._url = self._generate()

    @property
    def protocol(self) -> str:
        """Get URL Protocol.

        :return: URL Protocol
        :rtype: str
        """
        return self._protocol

    @protocol.setter
    def protocol(self, protocol_: str) -> None:
        """Set URL protocol.

        :param protocol_: URL Protocol
        :type protocol_: str
        """
        self._protocol = protocol_

    @property
    def host(self) -> str:
        """Get URL Host.

        :return: URL Host
        :rtype: str
        """
        return self._host

    @host.setter
    def host(self, host_: str) -> None:
        """Set URL Host.

        :param host_: URL Host
        :type host_: str
        """
        self._host = host_

    @property
    def port(self) -> int:
        """Get URL Port.

        :return: URL Port
        :rtype: int
        """
        return self._port

    @port.setter
    def port(self, port_: int) -> None:
        """Set URL Port.

        :param port_: URL Port
        :type port_: int
        """
        self._port = self._set_port(port_)

    @property
    def url(self) -> str:
        """Get URL generated.

        :return: URL
        :rtype: str
        """
        return self._url

    @url.setter
    def url(self, url_: str) -> None:
        """Set the URL.

        :param url_: URL to be set
        :type url_: str
        """
        self._url = url_

    def _set_port(self, port_: int) -> int:
        """Set the port number.

        If the supplied port is 0 or empty string,
        it will be set to 80 or 443 depending the value of protocol.

        :param port_: Port number to be corrected
        :type port_: int
        :return: Corrected port number
        :rtype: int
        """
        # Set port value
        if not port_:
            if self.protocol == HTTPS:
                port_ = DEFAULT_HTTPS_PORT
            else:
                port_ = DEFAULT_HTTP_PORT
        return port_

    def _generate(self) -> str:
        """Generate the URL.

        Generates the URL from protocol, host and port.

        :return: Base URL.
        :rtype: str
        """
        base_url = self.host
        # Check if port is supplied or not,
        # if supplied it should not be 80
        ports = [DEFAULT_HTTP_PORT]
        if self.port and self.port not in ports:
            base_url += f':{self.port}'

        return f'{self.protocol}://{base_url}'

    def get(self) -> str:
        """Get the url.

        :return: URL
        :rtype: str
        """
        return self._url

    def prepare(self, endpoint: Endpoint) -> str:
        """Prepare the URL with endpoint.

        :param endpoint: Endpoint to be concatinated with URL
        :type endpoint: Endpoint
        :return: API Endpoint
        :rtype: str
        """
        return f'{self._url}{endpoint.get()}'
