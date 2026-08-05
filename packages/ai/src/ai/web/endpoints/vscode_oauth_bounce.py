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

# =============================================================================
# VSCODE OAUTH BOUNCE ENDPOINT
# Bridges the hosted user-OAuth broker (oauth2.rocketride.ai) and the VS Code
# extension's deep link.
#
# The broker's redirect allowlist only accepts https://*.rocketride.ai URLs,
# so it can never redirect straight to vscode://... . The extension therefore
# sends the broker here (an allowlisted https page), and this page's script
# forwards the broker's query parameters to the editor deep link
# ``<scheme>://rocketride.rocketride/auth/google``, which
# CloudAuthProvider.handleGoogleOAuth consumes.
#
# Token material stays in the browser: it arrives in ``location.search`` and is
# re-emitted client-side only — it is never interpolated into the HTML and this
# handler never logs the query string.
# =============================================================================

from fastapi import Request
from fastapi.responses import HTMLResponse

from .auth_callback import _js_literal

# Editor URI schemes we are willing to bounce to. Restricting to a fixed set
# (rather than echoing an arbitrary ``scheme`` value) prevents the page from
# being abused as an open redirector for hostile schemes.
_ALLOWED_SCHEMES = frozenset({'vscode', 'vscode-insiders', 'cursor', 'windsurf', 'vscodium'})
_DEFAULT_SCHEME = 'vscode'

# The script runs at the end of <body> so the manual-fallback link exists when
# it executes. Only the parameters CloudAuthProvider.handleGoogleOAuth reads
# are forwarded; anything else in the query (e.g. our own ``scheme``) is
# dropped. ``str.replace`` is used instead of ``str.format`` so the literal
# ``{}`` in CSS/JS need no escaping (same convention as auth_callback.py).
_BOUNCE_HTML = """<!doctype html><html><head><title>RocketRide</title>
<style>body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;
justify-content:center;height:100vh;margin:0;background:#1e1e1e;color:#ccc;}
a{color:#4da3ff;}</style>
</head><body>
<p>Returning to your editor...</p>
<p><a id="open" href="#">Open editor</a> if nothing happens.</p>
<script>
// Forward the broker's OAuth result to the editor deep link.
var scheme = __RR_SCHEME_JS__;
var target = scheme + '://rocketride.rocketride/auth/google';
var src = new URLSearchParams(window.location.search);
var out = new URLSearchParams();
['tokens', 'state', 'oauth_error', 'error', 'error_description'].forEach(function (k) {
    var v = src.get(k);
    if (v !== null) out.set(k, v);
});
var q = out.toString();
var url = q ? target + '?' + q : target;
document.getElementById('open').href = url;
window.location.replace(url);
</script>
</body></html>
"""


async def vscode_oauth_bounce(request: Request) -> HTMLResponse:
    """
    Forward the OAuth broker's redirect to the VS Code extension deep link.

    The extension sets the broker's ``baseURL`` to this endpoint (with an
    optional ``scheme`` query parameter naming the editor's URI scheme); the
    broker appends ``tokens``/``state`` (or error parameters) and redirects the
    browser here. The returned page immediately re-navigates to
    ``<scheme>://rocketride.rocketride/auth/google`` carrying those parameters.

    Args:
        request (Request): The incoming redirect from the OAuth broker.

    Returns:
        HTMLResponse: An HTML page whose script forwards the OAuth parameters
                      to the editor deep link (with a manual-click fallback).
    """
    scheme = request.query_params.get('scheme') or _DEFAULT_SCHEME
    if scheme not in _ALLOWED_SCHEMES:
        scheme = _DEFAULT_SCHEME

    html = _BOUNCE_HTML.replace('__RR_SCHEME_JS__', _js_literal(scheme))
    return HTMLResponse(html)
