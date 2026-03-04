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

"""Request and Response validators."""

import requests  # type: ignore


def is_success(status_code: int) -> bool:
    """Check if the requests is successful (200).

    :param status_code: Response received via request
    :type status_code: int
    :return: True if response has status code 200/201, else False
    :rtype: bool
    """
    code_list = [requests.codes.okay, requests.codes.created]
    return status_code in code_list


def is_access_denied(status_code: int) -> bool:
    """Check if the status is access denied (401).

    :param status_code: Response status code
    :type status_code: int
    :return: True if status code is unauthorized else False
    :rtype: bool
    """
    return status_code == requests.codes.unauthorized


def is_too_many_requests(status_code: int) -> bool:
    """Check if the status is too may requests (249).

    :param status_code: Response status code
    :type status_code: int
    :return: True if status code is too many requests else False
    :rtype: bool
    """
    return status_code == requests.codes.too_many_requests
