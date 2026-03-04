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

"""Manage the endpoint for the URLs.

An endpoint is one end of a communication channel.

Each endpoint is the location from which APIs can access the resources they need to carry out their function.
"""

from ..utils.general import clean_endpoint


class Endpoint:
    """The endpoint for the API URLs.

    It cleans the endpoint url.
    """

    def __init__(self, endpoint: str) -> None:
        """Initialise the endpoint for the URL.

        :param endpoint: Endpoint string
        :type endpoint: str
        """
        self._endpoint = clean_endpoint(endpoint)

    @property
    def endpoint(self) -> str:
        """Get the endpoint.

        :return: Endpoint for the API.
        :rtype: str
        """
        return self._endpoint

    @endpoint.setter
    def endpoint(self, endpoint_: str) -> None:
        """Set the endpoint.

        :param endpoint_: Set the endpoint for the API.
        :type endpoint_: str
        """
        self._endpoint = clean_endpoint(endpoint_)

    def get(self) -> str:
        """Get the cleaned endpoint.

        :return: Endpoint for URL
        :rtype: str
        """
        return self._endpoint
