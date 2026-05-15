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
# AUTH CALLBACK ENDPOINT
# Safety-net redirect for misconfigured Zitadel redirect URIs.
#
# OAuth is now handled entirely client-side (PKCE). The browser exchanges the
# authorization code directly with Zitadel and sends the resulting access_token
# to the server via the login DAP command. This endpoint is only reached if
# Zitadel is still configured to redirect here instead of to the app URL.
# =============================================================================

import json
import os

from fastapi import Request
from fastapi.responses import HTMLResponse

# Self-contained HTML page that executes JavaScript to inspect the current
# URL's query parameters and forward OAuth results back to the app.
#
# The app URL is injected as a ``window.__RR_BASE__`` JSON literal (via
# ``json.dumps``) so any quote / backslash / ``</script>`` sequence in the
# admin-provided ``RR_APP_URL`` or in ``Host``/``X-Forwarded-Host`` headers
# is safely encoded rather than breaking the script or enabling XSS.
#
# We use ``str.replace('__RR_BASE_JS__', ...)`` rather than ``str.format(...)``
# so the literal ``{}`` characters in the inline CSS and JS don't need to be
# escaped as ``{{`` / ``}}``.
_REDIRECT_HTML = """<!doctype html><html><head><title>RocketRide</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#1e1e1e;color:#ccc;}</style>
<script>
// Forward code + state back to the app so the PKCE flow can complete.
var base = __RR_BASE_JS__;
var p = new URLSearchParams(window.location.search);
var code = p.get('code');
var state = p.get('state');
var error = p.get('error');
if (error) {
    window.location.replace(base + '?auth_error=' + encodeURIComponent(p.get('error_description') || error));
} else if (code) {
    var q = '?code=' + encodeURIComponent(code);
    if (state) q += '&state=' + encodeURIComponent(state);
    window.location.replace(base + q);
} else {
    window.location.replace(base);
}
</script>
</head><body><p>Redirecting...</p></body></html>
"""


def _js_literal(s: str) -> str:
    """
    Encode ``s`` as a safe JavaScript string literal.

    ``json.dumps`` already escapes quotes, backslashes, and control characters
    to produce a valid JSON string — which is also a valid JS string literal.
    Additionally escape the forward slash in any ``</`` sequence so the string
    cannot break out of a ``<script>`` element.
    """
    return json.dumps(s).replace('</', '<\\/')


async def auth_callback(request: Request) -> HTMLResponse:
    """
    Redirect Zitadel's OAuth callback back to the app so client-side PKCE can complete.
    Configure RR_APP_URL if the app is served from a different origin than this server.

    Args:
        request (Request): The incoming HTTP request from Zitadel's redirect.

    Returns:
        HTMLResponse: An HTML page containing JavaScript that immediately redirects
                      the browser to the app URL, carrying the OAuth code/state or
                      error parameters from Zitadel.
    """
    # Read the target app URL from the environment; administrators set this when
    # the app is hosted on a different origin than the API server.
    app_url = os.environ.get('RR_APP_URL', '').rstrip('/')

    if not app_url:
        # No explicit RR_APP_URL configured — fall back to the same origin that
        # received this request so the redirect stays on the correct host/port.
        # Note: request.base_url reflects Host/X-Forwarded-Host, which can be
        # attacker-influenced in some deployments; _js_literal below escapes it
        # safely for the script-tag context.
        app_url = str(request.base_url).rstrip('/')

    # Inject the resolved app URL as a JSON-encoded JS literal so any special
    # characters in the value (quotes, backslashes, </script>, etc.) are safely
    # escaped rather than breaking the surrounding script or enabling XSS.
    html = _REDIRECT_HTML.replace('__RR_BASE_JS__', _js_literal(app_url))

    # Return the HTML page; the browser will execute the script immediately and
    # navigate away, so the user never sees the "Redirecting..." text for long.
    return HTMLResponse(html)
