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
Workspace credential and provisioning commands: ``login`` and ``init``.

``login`` is the credential half: resolve the server, probe it, sign in
(OSS: API key; saas: browser PKCE ending in a durable minted rr_* key),
validate, and write the ``.env`` pairs.

``init`` is ``login`` plus the provisioning half: services catalog +
schemas, vendored platform packages, the agent docs bundle from
GET /client/docs, the CLAUDE.md stub, ``.gitignore`` entries, and the
workspace directory conventions. The provisioning operations live in the
rocketride_common source library (shared with the TypeScript CLI and the
VS Code extension); this module owns only the CLI-shaped parts —
prompts, the loopback OAuth listener, and command wiring. Kept in exact
parity with the TypeScript CLI's ``src/cli/commands/auth.ts``.
"""

import html
import json
import os
import socket
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Callable, Dict, Optional, Tuple

from rocketride_common.env import (
    ENV_DEPLOY_APIKEY,
    ENV_DEPLOY_URI,
    ENV_DEV_APIKEY,
    ENV_DEV_URI,
    write_dot_env,
)
from rocketride_common.auth_defaults import DEFAULT_CLI_CLIENT_ID, DEFAULT_ZITADEL_URL
from rocketride_common.pkce import build_authorize_url, encode_cd_credential, generate_pkce
from rocketride_common.provision import (
    ensure_gitignore,
    fetch_artifact,
    install_docs_bundle,
    install_stub,
    sync_service_catalog,
    to_http_base,
    write_if_changed,
)

from ..utils.common import connect_client, disconnect_all, prompt_hidden, prompt_line, run_cli_command
from ..utils.output import Output

# How long the loopback listener waits for the browser redirect (seconds)
OAUTH_TIMEOUT_S = 5 * 60


# =============================================================================
# SERVER RESOLUTION
# =============================================================================


def _install_source_uri() -> str:
    """
    Recover the server this CLI was installed from, as a prompt default.

    ``pip install <server>/client/python/latest`` records the URL in the
    installed distribution's PEP 610 ``direct_url.json``.

    Returns:
        The install-source origin, or empty when unknown.
    """
    try:
        from importlib.metadata import distribution

        text = distribution('rocketride').read_text('direct_url.json')
        if not text:
            return ''
        url = json.loads(text).get('url', '')
        if not url.lower().startswith(('http://', 'https://')):
            return ''
        parsed = urllib.parse.urlparse(url)
        return f'{parsed.scheme}://{parsed.netloc}'
    except Exception:  # noqa: BLE001
        return ''


def _resolve_server_uri(args, out: Output, env_key: str) -> str:
    """
    Resolve the server URI for login: flag, then ``.env``, then the
    install source, then an interactive prompt.

    Args:
        args: Parsed argparse namespace.
        out: Output channel (decides prompt eligibility).
        env_key: Which env pair's URI to consult.

    Returns:
        The chosen URI (may be empty when unresolvable non-interactively).
    """
    from ...core.constants import CONST_DEFAULT_WEB_LOCAL

    if getattr(args, 'uri', None):
        return args.uri
    from_env = os.environ.get(env_key, '')
    if from_env:
        return from_env
    fallback = _install_source_uri() or CONST_DEFAULT_WEB_LOCAL
    if not out.interactive:
        return fallback
    return prompt_line('Server address', fallback)


# =============================================================================
# SAAS SIGN-IN (PKCE, loopback redirect)
# =============================================================================


def _open_browser(url: str) -> None:
    """
    Open the system browser at a URL (best-effort; the URL is also printed).

    Args:
        url: The URL to open.
    """
    try:
        if sys.platform == 'win32':
            # ShellExecute takes the URL directly — no cmd.exe in the path,
            # so `&` in the query string survives (cmd's `start` treats `&`
            # as a command separator and truncates OAuth URLs)
            os.startfile(url)  # noqa: S606
        else:
            webbrowser.open(url)
    except Exception:  # noqa: BLE001
        pass


# The RocketRide web app's two palettes — 'rocketride' (dark) and
# 'rocketride-light', from packages/shell/public/themes/*.json (a unit test
# keeps these in step). The callback page cannot read the theme a user saved
# inside the web app (another origin's storage), so it follows the system
# light/dark setting onto these palettes — the web app's own default.
CALLBACK_PALETTES = {
    'dark': {
        'bg': '#080808',
        'paper': '#161616',
        'text': '#ffffff',
        'muted': 'rgba(255,255,255,0.40)',
        'border': 'rgba(255,255,255,0.08)',
        'buttonBg': '#00b9ec',
        'buttonFg': '#ffffff',
        'success': '#229954',
        'error': '#f44336',
    },
    'light': {
        'bg': '#f0efe9',
        'paper': '#e8e7e1',
        'text': '#0a0a0a',
        'muted': 'rgba(10,10,10,0.62)',
        'border': 'rgba(0,0,0,0.15)',
        'buttonBg': '#00a3d9',
        'buttonFg': '#0a0a0a',
        'success': '#229954',
        'error': '#f44336',
    },
}

# The web app's font stack (the themes' --rr-font-family).
_CALLBACK_FONT = "'Figtree Variable', 'Figtree', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

# The RocketRide mark, as on the landing page (flame in brand red, body in text colour).
_CALLBACK_LOGO = (
    '<svg class="logo" width="36" height="36" viewBox="0 0 191 192" fill="none" aria-hidden="true">'
    '<path d="M159.5 161.424L153.7 167.224C151.9 169.024 148.9 169.024 147 167.224L126.6 146.824C115.6 135.824 115.6 118.024 126.6 107.024C138.1 95.5245 138.1 76.9245 126.6 65.4245L125.1 63.9245C113.6 52.4245 95 52.4245 83.5 63.9245C72.5 74.9245 54.6 74.9245 43.6 63.9245L23.2 43.5245C21.4 41.7245 21.4 38.7245 23.2 36.8245L29 31.0245C37 23.0245 49.1 20.5245 59.6 24.9245L87.5 36.3245C97.3 40.1245 108.4 38.0245 116.3 31.1245L137 10.4245C138.6 8.92449 140.4 7.42449 142.5 6.22449C146.2 4.12449 150.3 3.02449 154.5 2.62449L185.4 0.0244895C188.3 -0.275511 190.8 2.22449 190.5 5.12449L187.8 36.4245C187.3 42.8245 184.5 48.8245 180.1 53.5245L160.5 73.1245C152.5 81.2245 150.1 93.3245 154.5 103.824L155.5 106.224L161.2 120.024L165.6 130.924C169.9 141.424 167.5 153.524 159.5 161.524V161.424Z" fill="currentColor" fill-opacity="0.85"/>'
    '<path d="M0.799997 190.325C-0.200003 189.325 -0.300003 187.625 0.599997 186.425L21.1 162.024C31.1 150.024 37.9 137.725 41.3 125.325C43.6 116.625 44.6 108.525 44.1 101.225C44.1 100.325 44.4 99.4245 45.1 98.8245C45.8 98.2245 46.8 97.9245 47.7 98.1245C65 101.625 83.5 98.3245 98.5 88.9245C99.6 88.2245 101.1 88.4245 102 89.3245C102.9 90.2245 103.1 91.7245 102.4 92.8245C93 107.825 89.7 126.325 93.2 143.525C93.4 144.325 93.2 145.225 92.6 145.925C92 146.625 91 147.225 90.1 147.125C82.8 146.625 74.6 147.525 66 149.925C53.6 153.225 41.2 160.025 29.3 170.125L4.9 190.625C3.8 191.525 2.1 191.525 0.999997 190.425H0.799997V190.325Z" fill="#F93822"/>'
    '</svg>'
)


# The RocketRide cloud's web app — where people use RocketRide in a browser.
_CLOUD_WEB_APP_URL = 'https://rocketride.ai/'


def web_app_url_for(server_base: str) -> str:
    """
    The web app a signed-in user should land on for a server.

    The cloud API (CONST_DEFAULT_WEB_CLOUD) is fronted by the cloud web app at
    rocketride.ai; any other server serves its web app from its own origin.
    Mirrors the TypeScript CLI's webAppUrlFor.

    Args:
        server_base: The server's http(s) origin (to_http_base of its URI).

    Returns:
        The web app URL, with a trailing slash.
    """
    from ...core.constants import CONST_DEFAULT_WEB_CLOUD

    origin = server_base.rstrip('/')
    return (
        _CLOUD_WEB_APP_URL if _canonical_origin(origin) == _canonical_origin(CONST_DEFAULT_WEB_CLOUD) else f'{origin}/'
    )


def _canonical_origin(url: str) -> str:
    """Lowercase scheme://host with a default port dropped (like the WHATWG URL origin)."""
    parsed = urllib.parse.urlparse(url)
    try:
        port = parsed.port
    except ValueError:
        return url.lower()
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or '').lower()
    if port is None or (scheme, port) in (('http', 80), ('https', 443)):
        return f'{scheme}://{host}'
    return f'{scheme}://{host}:{port}'


def _palette_vars(p: Dict[str, str]) -> str:
    return (
        f'--bg:{p["bg"]};--paper:{p["paper"]};--text:{p["text"]};--muted:{p["muted"]};--border:{p["border"]};'
        f'--btn-bg:{p["buttonBg"]};--btn-fg:{p["buttonFg"]};--ok:{p["success"]};--err:{p["error"]}'
    )


def _render_callback_page(
    ok: bool, web_url: Optional[str] = None, error: Optional[str] = None, waitlisted: bool = False
) -> str:
    """
    Render the page the browser lands on after the sign-in redirect, branded
    like the RocketRide landing page and themed with the web app's palettes
    (system light/dark).

    Success tries to close the tab. Chromium allows that for this tab;
    Firefox only lets scripts close windows scripts opened, so there the page
    stays as a finished state, with a link to the web app. A waitlisted
    account stays open with its access-queue notice. A failure shows the
    reason and makes no close attempt. Mirrors the TypeScript CLI's
    renderCallbackPage.

    Args:
        ok: Whether sign-in finished (credential exchanged).
        web_url: The server's web app, linked from the page (absolute http(s) only).
        error: The failure reason (when not ok).
        waitlisted: The account is in the access queue (when ok).

    Returns:
        The HTML document.
    """
    style = ''.join(
        [
            f':root{{{_palette_vars(CALLBACK_PALETTES["light"])}}}',
            f'@media (prefers-color-scheme:dark){{:root{{{_palette_vars(CALLBACK_PALETTES["dark"])}}}}}',
            '*{box-sizing:border-box}',
            f'body{{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--text);font-family:{_CALLBACK_FONT};-webkit-font-smoothing:antialiased}}',
            'header{display:flex;align-items:center;gap:10px;padding:20px 28px}',
            'header .logo{color:var(--text);display:block;flex-shrink:0}',
            'header span{font-size:22px;font-weight:700}',
            'main{flex:1;display:grid;place-items:center;padding:24px}',
            '.card{width:100%;max-width:440px;padding:40px 36px;text-align:center;background:var(--paper);border:1px solid var(--border);border-radius:16px}',
            '.badge{width:56px;height:56px;margin:0 auto 20px;display:grid;place-items:center;border-radius:50%;border:2px solid var(--state)}',
            '.badge svg{display:block;stroke:var(--state)}',
            'h1{margin:0 0 8px;font-size:28px;font-weight:800}',
            'p{margin:0;font-size:15px;line-height:1.5;color:var(--muted)}',
            '.reason{margin-top:12px;color:var(--text);word-break:break-word}',
            '.btn{display:inline-block;margin-top:28px;padding:10px 22px;border-radius:8px;background:var(--btn-bg);color:var(--btn-fg);font-weight:700;font-size:15px;text-decoration:none}',
            '.hint{margin-top:18px;font-size:13px}',
        ]
    )
    head = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<meta name="color-scheme" content="light dark"><title>RocketRide sign-in</title><style>{style}</style></head>'
        f'<body><header>{_CALLBACK_LOGO}<span>RocketRide</span></header><main>'
    )

    if not ok:
        badge = '<div class="badge" style="--state:var(--err)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg></div>'
        reason = html.escape(error or 'unknown error')
        return f'{head}<div class="card">{badge}<h1>Sign-in failed</h1><p class="reason">{reason}</p><p class="hint">Return to your terminal and run <strong>rocketride login</strong> again.</p></div></main></body></html>'

    # step: the web app link — absolute http(s) with a host only
    parsed_url = urllib.parse.urlparse(web_url or '')
    target_url = web_url if parsed_url.scheme in ('http', 'https') and parsed_url.hostname else ''

    badge = '<div class="badge" style="--state:var(--ok)"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>'
    button = f'<a class="btn" href="{html.escape(target_url)}">Open RocketRide</a>' if target_url else ''
    if waitlisted:
        return f'{head}<div class="card">{badge}<h1>You\'re on the list</h1><p>Your account is in the access queue; you will be emailed when it is activated.</p>{button}</div></main></body></html>'
    return f'{head}<div class="card">{badge}<h1>You\'re signed in</h1><p>Return to your terminal; the RocketRide CLI is ready.</p>{button}<p class="hint">You can close this tab.</p></div></main><script>window.close();</script></body></html>'


def _authorize_via_loopback(
    zitadel_url: str,
    client_id: str,
    challenge: str,
    out: Output,
    open_browser: Callable[[str], None] = _open_browser,
) -> Tuple[Dict[str, str], Callable[[str], None]]:
    """
    Run the loopback-redirect PKCE authorization and return the code.

    Starts a listener on a random 127.0.0.1 port, sends the browser to
    the Zitadel authorize URL, and returns the ``code`` query parameter
    from the redirect. A code is not a sign-in yet (the exchange and the
    key mint can still fail), so the browser's request is held open until
    the caller reports the real outcome through ``finish``. A provider
    error or a code-less redirect is answered at once.

    Args:
        zitadel_url: Base URL of the Zitadel instance.
        client_id: OAuth public client id.
        challenge: The S256 code challenge.
        out: Output channel for progress lines.
        open_browser: Opens the authorize URL (the system browser by default).

    Returns:
        A dict with ``code`` and the exact ``redirectUri`` used, and
        ``finish(page)``, which answers the held browser request with the
        rendered page and closes the listener.

    Raises:
        RuntimeError: On timeout, rejection, or a code-less redirect.
    """
    result: Dict[str, str] = {}
    done = threading.Event()
    final: Dict[str, str] = {}
    page_ready = threading.Event()

    class CallbackHandler(BaseHTTPRequestHandler):
        """One-shot handler for the OAuth loopback redirect."""

        def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler contract)
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != '/auth/callback':
                self.send_response(404)
                self.end_headers()
                return
            params = urllib.parse.parse_qs(parsed.query)
            if 'error' in params:
                result['error'] = (params.get('error_description') or params.get('error') or ['unknown'])[0]
                page = _render_callback_page(False, error=result['error'])
                done.set()
            else:
                result['code'] = (params.get('code') or [''])[0]
                done.set()
                if result['code']:
                    # hold the browser until the caller knows the outcome
                    page_ready.wait(OAUTH_TIMEOUT_S)
                    page = final.get('page') or _render_callback_page(
                        False, error='Sign-in did not complete; see your terminal.'
                    )
                else:
                    page = _render_callback_page(False, error='The sign-in redirect carried no authorization code.')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(page.encode('utf-8'))

        def log_message(self, format, *log_args):  # noqa: A002
            """Silence the default request logging."""

    server = HTTPServer(('127.0.0.1', 0), CallbackHandler)
    port = server.server_address[1]
    redirect_uri = f'http://127.0.0.1:{port}/auth/callback'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def close() -> None:
        # shutdown() waits for the handler, so a held page is written first
        server.shutdown()
        server.server_close()

    def finish(page: str) -> None:
        if page_ready.is_set():
            return
        final['page'] = page
        page_ready.set()
        close()

    try:
        authorize_url = build_authorize_url(zitadel_url, client_id, redirect_uri, challenge)
        out.line('Opening your browser to sign in...')
        out.line(f'If it did not open, visit: {authorize_url}')
        open_browser(authorize_url)

        if not done.wait(OAUTH_TIMEOUT_S):
            raise RuntimeError('Sign-in timed out waiting for the browser redirect')
        if 'error' in result:
            raise RuntimeError(f'Sign-in was rejected: {result["error"]}')
        if not result.get('code'):
            raise RuntimeError('Sign-in redirect carried no authorization code')
    except BaseException:
        close()
        raise
    return {'code': result['code'], 'redirectUri': redirect_uri}, finish


async def _sign_in_saas(uri: str, out: Output) -> str:
    """
    Sign in to a saas server and mint a durable API key for ``.env``.

    The Zitadel host and client id are BAKED into this build (like the
    VS Code extension's id) — the client package a server serves was
    built from the same tree as that server. The PKCE exchange returns a
    90-day session key; the durable credential is a freshly minted
    personal API key (never expires), created over the same
    authenticated connection.

    Args:
        uri: The server URI.
        out: Output channel.

    Returns:
        The minted rr_* key, or empty on waitlisted.
    """
    from rocketride import RocketRideClient

    # step: PKCE verifier + S256 challenge (shared helper)
    verifier, challenge = generate_pkce()

    # step: browser authorization via the loopback redirect; the browser
    # waits on its callback page until this sign-in finishes
    grant, finish = _authorize_via_loopback(DEFAULT_ZITADEL_URL, DEFAULT_CLI_CLIENT_ID, challenge, out)
    web_url = web_app_url_for(to_http_base(uri))
    page = _render_callback_page(False, error='Sign-in did not complete; see your terminal.')

    # step: exchange the code over a temporary DAP connection — the
    # credential string is the cd_-encoded PKCE triple; the server
    # consumes the Zitadel tokens and returns an rr_* session key
    credential = encode_cd_credential(
        {'code': grant['code'], 'verifier': verifier, 'redirectUri': grant['redirectUri']}
    )
    try:
        client = RocketRideClient(uri, auth=credential)
    except BaseException as err:
        finish(_render_callback_page(False, error=str(err)))
        raise
    try:
        result = await client.connect() or {}
        if result.get('waitlisted'):
            name = result.get('displayName', '')
            suffix = f', {name}' if name else ''
            out.line(
                f'Thanks for signing up{suffix}! Your account is in the access queue — you will be emailed when it is activated.'
            )
            page = _render_callback_page(True, web_url=web_url, waitlisted=True)
            return ''
        if not result.get('userToken'):
            raise RuntimeError('Sign-in succeeded but the server returned no token')

        # step: mint the durable credential — a personal API key that,
        # unlike the session key, never expires and survives sign-outs.
        # permissions=None inherits everything from the user (full PAT).
        key_name = f'CLI on {socket.gethostname()}'
        minted = await client.account.create_key(name=key_name) or {}
        key = minted.get('key')
        if not key:
            raise RuntimeError('Sign-in succeeded but the server minted no API key')
        display = result.get('displayName', '')
        out.line(f'Signed in{f" as {display}" if display else ""}; minted API key {key_name!r}.')
        page = _render_callback_page(True, web_url=web_url)
        return key
    except Exception as err:
        page = _render_callback_page(False, error=str(err))
        raise
    finally:
        finish(page)
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass


# =============================================================================
# LOGIN FLOW (shared by `login` and `init`)
# =============================================================================


async def _run_login(args, out: Output, for_deploy: bool) -> Optional[Dict[str, str]]:
    """
    Run the credential flow: resolve server, probe, authenticate,
    validate, and persist the ``.env`` pair(s).

    Args:
        args: Parsed argparse namespace (uri/apikey/deploy flags).
        out: Output channel.
        for_deploy: Target the ROCKETRIDE_DEPLOY_* pair instead of dev.

    Returns:
        Dict with the validated ``uri``/``apikey``, or None on failure.
    """
    from rocketride import RocketRideClient

    env_uri_key = ENV_DEPLOY_URI if for_deploy else ENV_DEV_URI
    uri = _resolve_server_uri(args, out, env_uri_key)
    if not uri:
        out.fail('No server address given', 'pass --uri or run interactively')
        return None

    # step: probe — unauthenticated; decides OSS vs saas sign-in
    out.line(f'Probing {uri}...')
    info = await RocketRideClient.get_server_info(uri)
    is_saas = 'saas' in (info.get('capabilities') or [])
    # The engine reports version as {version, hash, stamp}; older servers
    # may send a plain string — display either without leaking the object
    raw_version = info.get('version')
    version_display = (
        raw_version if isinstance(raw_version, str) else (raw_version or {}).get('version', '(unknown version)')
    )
    out.line(f'Server {version_display or "(unknown version)"} — {"saas" if is_saas else "oss"} mode.')

    # step: obtain a credential
    apikey = getattr(args, 'apikey', None) or ''
    if not apikey:
        if is_saas and DEFAULT_ZITADEL_URL and DEFAULT_CLI_CLIENT_ID:
            apikey = await _sign_in_saas(uri, out)
            if not apikey:
                return None  # waitlisted — message already printed
        elif is_saas:
            out.fail(
                'This CLI build carries no sign-in configuration',
                'create an API key in the web UI and run: rocketride login --apikey <key>',
            )
            return None
        elif out.interactive:
            apikey = prompt_hidden('API key')
        else:
            out.fail('An API key is required in non-interactive mode', 'pass --apikey')
            return None

    # step: validate by connecting once with the credential
    out.line('Validating credentials...')
    await connect_client(uri, apikey)
    await disconnect_all()

    # step: persist. The deploy pair mirrors the dev pair by default (one
    # server = one target) unless --no-deploy keeps deploys unarmed; a
    # deploy pair already pointing elsewhere is never overwritten.
    updates: Dict[str, str] = {}
    if for_deploy:
        updates[ENV_DEPLOY_URI] = uri
        updates[ENV_DEPLOY_APIKEY] = apikey
    else:
        updates[ENV_DEV_URI] = uri
        updates[ENV_DEV_APIKEY] = apikey
        existing_deploy_uri = os.environ.get(ENV_DEPLOY_URI, '')
        mirror_deploy = getattr(args, 'deploy', True) and existing_deploy_uri in ('', uri)
        if mirror_deploy:
            updates[ENV_DEPLOY_URI] = uri
            updates[ENV_DEPLOY_APIKEY] = apikey
    env_path = write_dot_env(updates)
    for key, value in updates.items():
        os.environ[key] = value
    out.line(f'Saved {", ".join(updates.keys())} to {env_path}.')

    # step: the .env now holds a live credential — make it un-committable
    # in the same breath, never as a later provisioning step
    if ensure_gitignore(os.getcwd()):
        out.line('.gitignore: added .rocketride/ and .env.')
    return {'uri': uri, 'apikey': apikey}


# =============================================================================
# COMMAND ENTRY POINTS
# =============================================================================


async def run_login(args) -> int:
    """
    Execute the ``login`` command.

    Args:
        args: Parsed argparse namespace.

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        result = await _run_login(args, out, getattr(args, 'deploy_pair', False))
        if result is None:
            return 1
        out.result({'uri': result['uri'], 'saved': True})
        return 0

    return await run_cli_command(args, action)


async def run_init(args) -> int:
    """
    Execute the ``init`` command: login + workspace provisioning.

    Args:
        args: Parsed argparse namespace.

    Returns:
        Exit code.
    """

    async def action(out: Output) -> int:
        workspace_root = os.getcwd()

        # step: credentials — reuse a valid .env silently, else login
        uri = getattr(args, 'uri', None) or os.environ.get(ENV_DEV_URI, '')
        apikey = getattr(args, 'apikey', None) or os.environ.get(ENV_DEV_APIKEY, '')
        have_credentials = False
        if uri and apikey:
            try:
                await connect_client(uri, apikey)
                await disconnect_all()
                have_credentials = True
                out.line(f'Using existing credentials for {uri}.')
            except Exception:  # noqa: BLE001
                await disconnect_all()
                out.line(f'Stored credentials for {uri} were rejected — signing in again.')
        if not have_credentials:
            login = await _run_login(args, out, False)
            if login is None:
                return 1
            uri = login['uri']
            apikey = login['apikey']

        # step: services catalog + schemas over one connection
        client = await connect_client(uri, apikey)
        services_response = await client.get_services()
        services = services_response.get('services', {}) or {}
        sync_service_catalog(workspace_root, services, out.line)
        await disconnect_all()

        # step: vendor the platform packages from the same server — every
        # fetch stands alone, so one unreachable artifact cannot cost the
        # workspace its docs, its conventions, or its directories
        base = to_http_base(uri)
        degraded = False

        try:
            shell_tgz = fetch_artifact(base, 'client/shell', 'platform package (shell.tgz)')
            if write_if_changed(os.path.join(workspace_root, '.rocketride', 'shell', 'shell.tgz'), shell_tgz):
                out.line('Vendored .rocketride/shell/shell.tgz.')
        except Exception as err:  # noqa: BLE001
            degraded = True
            out.line(f'warning: could not vendor the platform package (shell.tgz): {err}')

        try:
            client_tgz = fetch_artifact(base, 'client/typescript', 'client SDK package (rocketride.tgz)')
            if write_if_changed(os.path.join(workspace_root, '.rocketride', 'client', 'rocketride.tgz'), client_tgz):
                out.line('Vendored .rocketride/client/rocketride.tgz.')
        except Exception as err:  # noqa: BLE001
            degraded = True
            out.line(f'warning: could not vendor the client SDK package (rocketride.tgz): {err}')

        # step: agent docs bundle (sweep + stamp) and the CLAUDE.md stub
        try:
            install_docs_bundle(workspace_root, base, out.line)
        except Exception as err:  # noqa: BLE001
            degraded = True
            out.line(f'warning: could not install the agent docs bundle: {err}')
        try:
            if install_stub(workspace_root, 'CLAUDE.md', 'CLAUDE.md'):
                out.line('CLAUDE.md stub installed.')
        except RuntimeError as err:
            out.line(f'CLAUDE.md stub skipped: {err}')

        # step: workspace conventions
        ensure_gitignore(workspace_root)
        for dir_name in ('apps', 'pipelines', 'nodes'):
            os.makedirs(os.path.join(workspace_root, dir_name), exist_ok=True)

        out.line('')
        if degraded:
            # Credentials and conventions are on disk; only the downloads
            # are missing, so the fix is to re-run once the server answers
            out.line(f'Workspace set up against {uri}, but some downloads failed.')
            out.line('Run `rocketride init` again once the server is reachable to finish provisioning.')
            out.result({'uri': uri, 'workspaceRoot': workspace_root, 'initialized': False})
            return 1
        out.line(f'Workspace initialized against {uri}.')
        out.line('Docs: .rocketride/docs/ROCKETRIDE_README.md is the starting point.')
        out.result({'uri': uri, 'workspaceRoot': workspace_root, 'initialized': True})
        return 0

    return await run_cli_command(args, action)
