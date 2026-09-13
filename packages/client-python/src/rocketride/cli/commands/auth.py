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

import json
import os
import socket
import sys
import threading
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Dict, Optional

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


def _authorize_via_loopback(zitadel_url: str, client_id: str, challenge: str, out: Output) -> Dict[str, str]:
    """
    Run the loopback-redirect PKCE authorization and return the code.

    Starts a listener on a random 127.0.0.1 port, sends the browser to
    the Zitadel authorize URL, and returns the ``code`` query parameter
    from the redirect.

    Args:
        zitadel_url: Base URL of the Zitadel instance.
        client_id: OAuth public client id.
        challenge: The S256 code challenge.
        out: Output channel for progress lines.

    Returns:
        Dict with ``code`` and the exact ``redirectUri`` used.

    Raises:
        RuntimeError: On timeout, rejection, or a code-less redirect.
    """
    result: Dict[str, str] = {}
    done = threading.Event()

    class CallbackHandler(BaseHTTPRequestHandler):
        """One-shot handler for the OAuth loopback redirect."""

        def do_GET(self):  # noqa: N802 (BaseHTTPRequestHandler contract)
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path != '/auth/callback':
                self.send_response(404)
                self.end_headers()
                return
            params = urllib.parse.parse_qs(parsed.query)
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(
                b'<html><body><p>RocketRide sign-in received. You can close this window and return to the terminal.</p></body></html>'
            )
            if 'error' in params:
                result['error'] = (params.get('error_description') or params.get('error') or ['unknown'])[0]
            else:
                result['code'] = (params.get('code') or [''])[0]
            done.set()

        def log_message(self, format, *log_args):  # noqa: A002
            """Silence the default request logging."""

    server = HTTPServer(('127.0.0.1', 0), CallbackHandler)
    port = server.server_address[1]
    redirect_uri = f'http://127.0.0.1:{port}/auth/callback'
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        authorize_url = build_authorize_url(zitadel_url, client_id, redirect_uri, challenge)
        out.line('Opening your browser to sign in...')
        out.line(f'If it did not open, visit: {authorize_url}')
        _open_browser(authorize_url)

        if not done.wait(OAUTH_TIMEOUT_S):
            raise RuntimeError('Sign-in timed out waiting for the browser redirect')
    finally:
        server.shutdown()
        server.server_close()

    if 'error' in result:
        raise RuntimeError(f'Sign-in was rejected: {result["error"]}')
    if not result.get('code'):
        raise RuntimeError('Sign-in redirect carried no authorization code')
    return {'code': result['code'], 'redirectUri': redirect_uri}


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

    # step: browser authorization via the loopback redirect
    grant = _authorize_via_loopback(DEFAULT_ZITADEL_URL, DEFAULT_CLI_CLIENT_ID, challenge, out)

    # step: exchange the code over a temporary DAP connection — the
    # credential string is the cd_-encoded PKCE triple; the server
    # consumes the Zitadel tokens and returns an rr_* session key
    credential = encode_cd_credential(
        {'code': grant['code'], 'verifier': verifier, 'redirectUri': grant['redirectUri']}
    )
    client = RocketRideClient(uri, auth=credential)
    try:
        result = await client.connect() or {}
        if result.get('waitlisted'):
            name = result.get('displayName', '')
            suffix = f', {name}' if name else ''
            out.line(
                f'Thanks for signing up{suffix}! Your account is in the access queue — you will be emailed when it is activated.'
            )
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
        return key
    finally:
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
