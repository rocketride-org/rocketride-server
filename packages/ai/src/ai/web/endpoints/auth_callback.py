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

from fastapi import Request
from fastapi.responses import HTMLResponse

# A self-contained HTML page that immediately executes JavaScript to inspect
# the current URL's query parameters and forward OAuth results back to the app.
# Double braces {{ }} are Python format-string escapes for literal curly braces
# that appear in the embedded JavaScript.
_REDIRECT_HTML = """<!doctype html><html><head><title>RocketRide</title>
<style>body{{font-family:sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#1e1e1e;color:#ccc;}}</style>
<script>
// Forward code + state back to the app so the PKCE flow can complete.
var p = new URLSearchParams(window.location.search);
var code = p.get('code');
var state = p.get('state');
var error = p.get('error');
var base = '{app_url}';
if (error) {{
    window.location.replace(base + '?auth_error=' + encodeURIComponent(p.get('error_description') || error));
}} else if (code) {{
    var q = '?code=' + encodeURIComponent(code);
    if (state) q += '&state=' + encodeURIComponent(state);
    window.location.replace(base + q);
}} else {{
    window.location.replace(base);
}}
</script>
</head><body><p>Redirecting...</p></body></html>
"""


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
    import os

    # Read the target app URL from the environment; administrators set this when
    # the app is hosted on a different origin than the API server.
    app_url = os.environ.get('RR_APP_URL', '').rstrip('/')

    if not app_url:
        # No explicit RR_APP_URL configured — fall back to the same origin that
        # received this request so the redirect stays on the correct host/port.
        app_url = str(request.base_url).rstrip('/')

    # Substitute the resolved app URL into the HTML template, replacing the
    # {app_url} placeholder that the embedded JavaScript uses as its redirect base.
    html = _REDIRECT_HTML.replace('{app_url}', app_url)

    # Return the HTML page; the browser will execute the script immediately and
    # navigate away, so the user never sees the "Redirecting..." text for long.
    return HTMLResponse(html)
