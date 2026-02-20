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

"""Module contains the default value for variable used in sac request."""

from .general import NO_AUTH

DEFAULT_TIMEOUT = 5  # seconds
DEFAULT_MAX_RETRY = 3  # number
DEFAULT_EXP_MAX_RETRY = 10  # number
DEFAULT_RETRY_INTERVAL = 1  # seconds
DEFAULT_STATUS_FORCE_LIST = [500, 502, 503, 504]
DEFAULT_AUTH_TYPE = NO_AUTH
DEFAULT_VERIFY = True
DEFAULT_HTTP_PORT = 80
DEFAULT_HTTPS_PORT = 443
