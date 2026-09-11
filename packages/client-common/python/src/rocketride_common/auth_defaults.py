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
Baked sign-in defaults for the CLI's saas browser flow.

Both values are PUBLIC OAuth identifiers (PKCE public client — no
secret), baked into the client build exactly like the VS Code
extension's client id: the client packages a server serves were built
from the same tree and ``.config`` as that server, so the baked values
always match the server they were downloaded from.

``client-common:stamp`` rewrites the literals below from ``.config``
(RR_ZITADEL_URL / RR_ZITADEL_CLI_CLIENT_ID) at build time. Do not
hand-edit the values; change ``.config`` instead. Empty values mean the
build carries no CLI sign-in — ``login`` then directs users to
``--apikey``.

Behavioral twin of ``client-common/typescript``'s ``auth-defaults.ts``.
"""

# Zitadel instance the CLI's browser sign-in authorizes against
DEFAULT_ZITADEL_URL = 'https://auth.rocketride.ai'

# OAuth public client id of the CLI's Native (loopback) app
DEFAULT_CLI_CLIENT_ID = '387171737705415568'
