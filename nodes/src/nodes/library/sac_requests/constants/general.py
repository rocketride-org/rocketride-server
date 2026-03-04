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

"""Constants used in sac request context."""

HTTP = 'http'
HTTPS = 'https'
AUTHORIZATION = 'Authorization'
HEADERS = 'headers'
REFRESH_HEADERS = 'refresh_headers'
NO_AUTH = 'NO_AUTH'  # nosec
BASIC_AUTH = 'BASIC_AUTH'  # nosec
BEARER_TOKEN = 'BEARER_TOKEN'  # nosec
AUTH = 'auth'
AUTH_TYPE = 'auth_type'  # nosec
MAX_RETRY = 'max_retry'
RETRY_INTERVAL = 'retry_interval'
STATUS_FORCE_LIST = 'status_force_list'
TIMEOUT = 'timeout'
VERIFY = 'verify'
URL = 'url'
DATA = 'data'
PARAMS = 'params'
ENDPOINT = 'endpoint'
ERRCODE = 'errcode'
MESSAGE = 'message'
COOKIE = 'cookie'

# Request Types
GET = 'get'
HEAD = 'head'
POST = 'post'
PUT = 'put'
DELETE = 'delete'
OPTIONS = 'options'
PATCH = 'patch'

# Request Headers
X_API_KEY = 'x-api-key'

# Response headers
RETRY_AFTER = 'Retry-After'

REQ_LOGGER = 'logger'
