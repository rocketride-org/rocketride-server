# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
rocketride_common — operational library shared by RocketRide client
front-ends (the ``rocketride`` CLI executable, and any future Python
consumer).

This is a SOURCE library, not a distribution: consumers compile/stage it
in (the client-python wheel build includes it as a second top-level
package) and it never ships standalone. It never enters the client SDK's
contracted API surface. The TypeScript twin lives at
``client-common/typescript`` and is kept in sync with this tree.
"""

from .auth_defaults import DEFAULT_CLI_CLIENT_ID, DEFAULT_ZITADEL_URL
from .env import (
    ENV_DEPLOY_APIKEY,
    ENV_DEPLOY_URI,
    ENV_DEV_APIKEY,
    ENV_DEV_URI,
    NO_DEPLOY_TARGET_MESSAGE,
    load_dot_env,
    parse_env_line,
    write_dot_env,
)
from .pkce import OAUTH_SCOPE, build_authorize_url, encode_cd_credential, generate_pkce
from .provision import (
    DOCS_STAMP_FILE,
    GITIGNORE_ENTRIES,
    MARKER_BEGIN,
    MARKER_END,
    ensure_gitignore,
    fetch_artifact,
    install_docs_bundle,
    install_stub,
    merge_stub_content,
    strip_stub_content,
    sync_service_catalog,
    to_http_base,
    write_if_changed,
)

__all__ = [
    'DEFAULT_CLI_CLIENT_ID',
    'DEFAULT_ZITADEL_URL',
    'DOCS_STAMP_FILE',
    'ENV_DEPLOY_APIKEY',
    'ENV_DEPLOY_URI',
    'ENV_DEV_APIKEY',
    'ENV_DEV_URI',
    'GITIGNORE_ENTRIES',
    'MARKER_BEGIN',
    'MARKER_END',
    'NO_DEPLOY_TARGET_MESSAGE',
    'OAUTH_SCOPE',
    'build_authorize_url',
    'encode_cd_credential',
    'ensure_gitignore',
    'fetch_artifact',
    'generate_pkce',
    'install_docs_bundle',
    'install_stub',
    'load_dot_env',
    'merge_stub_content',
    'parse_env_line',
    'strip_stub_content',
    'sync_service_catalog',
    'to_http_base',
    'write_dot_env',
    'write_if_changed',
]
