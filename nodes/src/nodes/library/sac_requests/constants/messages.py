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

"""Success and Error message constants."""

INVALID_HEADER_FORMAT = 'Invalid header format supplied. Request header must be a key-value pair.'
BASIC_AUTH_PARAMS_MISSING = 'Basic Authentication Parameters (username, password) are missing'  # nosec
MISSING_AUTH_TOKEN = """Authorization token is missing in header"""  # nosec
UNKNOWN_AUTH_TYPE = 'Unrecognised auth type supplied.'


# Http error response messages
HTTP_ERROR = 'Request to {url} failed with the message = {msg}.'
CONNECTION_ERROR = 'Connection to {url} resulted in error with message = {msg}'
TIMEOUT_ERROR = 'Request to {url} is timed out with message = {msg}.'
SSL_ERROR = 'Request to {url} resulted in SSLError with message = {msg}.'
REQUEST_ERROR = 'Failed to send a request to {url} with message = {msg}.'
TOO_MANY_REQUESTS = 'Too many requests sent to {url}, received {code} with message: {err}'
INVALID_AUTH_TOKEN = 'Lifetime validation failed, the token got expired during the call'
REQ_WAIT_TIME = 'Waiting for {sec} seconds before retrying the request another time (current attempt #{count}, including throttling {count_throttling} attempts).'
REQ_ATTEMPT_EXCEEDED = 'Request attempt exceeded the maximum number of attempts (total {count} attempts , including throttling {count_throttling} attempts).'
