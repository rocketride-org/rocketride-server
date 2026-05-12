# MIT License
# Copyright (c) 2026 Aparavi Software AG

# =============================================================================
# AUTH CALLBACK ENDPOINT
# Safety-net redirect for misconfigured Zitadel redirect URIs.
#
# Fix F-08: RR_APP_URL is now required. If it is not set the endpoint returns
# a 500 error with a clear message instead of silently falling back to the
# attacker-influenced Host / X-Forwarded-Host header.
# =============================================================================

import json
import os

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse

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

    ``json.dumps`` already escapes quotes, backslashes, and control characters.
    Additionally escape ``</`` so the string cannot break out of a ``<script>``.
    """
    return json.dumps(s).replace('</', '<\\/')


async def auth_callback(request: Request) -> HTMLResponse:
    """
    Redirect Zitadel's OAuth callback back to the app so client-side PKCE can complete.

    Fix F-08: RR_APP_URL must be explicitly configured. The previous fallback
    to request.base_url (derived from the Host header) has been removed because
    the Host header can be attacker-controlled in misconfigured deployments,
    allowing an OAuth authorization code to be stolen via an open redirect.

    Set RR_APP_URL to the URL of the frontend app (e.g. https://app.example.com).

    Args:
        request (Request): The incoming HTTP request from Zitadel's redirect.

    Returns:
        HTMLResponse: An HTML page that immediately redirects the browser to
                      the configured app URL with OAuth parameters forwarded.
        JSONResponse (500): If RR_APP_URL is not configured.
    """
    app_url = os.environ.get('RR_APP_URL', '').rstrip('/')

    if not app_url:
        # F-08 fix: fail with a clear error rather than falling back to a
        # potentially attacker-influenced Host header.
        return JSONResponse(
            status_code=500,
            content={
                'error': 'Server misconfiguration',
                'detail': (
                    'RR_APP_URL is not set. '
                    'Configure RR_APP_URL to the frontend application URL '
                    '(e.g. https://app.example.com) so the OAuth callback '
                    'can redirect correctly.'
                ),
            },
        )

    html = _REDIRECT_HTML.replace('__RR_BASE_JS__', _js_literal(app_url))
    return HTMLResponse(html)
