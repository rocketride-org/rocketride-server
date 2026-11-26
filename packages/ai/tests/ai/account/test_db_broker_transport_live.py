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

"""Transport safety of ``AccountBase.resolve_db_dsn`` against a REAL local HTTPS broker.

``test_resolve_db_dsn.py`` plays the broker with a plain-HTTP localhost server.
That cannot show what the broker call does with TLS, certificates, redirects or
an ambient proxy, so this module runs the real ``urllib`` path against a real
TLS listener whose certificate chains to a throwaway CA generated at test time
(nothing is written outside ``tmp_path``; no key is ever committed).

Trust is given the way the deployment gives it: ``SSL_CERT_FILE`` names the CA
bundle. Certificate verification is never disabled.

What is pinned:

* a 301/302/303/307/308 from the broker is refused and NO request reaches the
  redirect target (the broker token must not follow a redirect to another
  origin, including an https -> http downgrade, and a redirected body must not
  be accepted as the broker's answer);
* a certificate for the wrong host, and a certificate from the wrong CA, are
  refused;
* an ambient ``http_proxy`` / ``https_proxy`` is ignored: the token goes
  straight to the broker, never to a proxy named by the process environment;
* no failure text carries the broker token, a DSN password or URL userinfo.

Skips cleanly when neither the ``cryptography`` package nor the ``openssl``
command is available to mint the throwaway CA.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import shutil
import socket
import ssl
import subprocess
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from ai.account.base import AccountBase

BROKER_TOKEN = 'live-broker-token-4f9c1e7a'
DSN_PASSWORD = 'live-dsn-password-b21d'
URL_PASSWORD = 'live-userinfo-password-77aa'
GOOD_DSN = f'postgresql://role_t1:{DSN_PASSWORD}@pooler.internal:5432/t_t1?sslmode=require'

_ENV_TO_CLEAR = (
    'RR_DB_BROKER_URL',
    'RR_DB_BROKER_TOKEN',
    'ROCKETRIDE_DB_BROKER_URL',
    'ROCKETRIDE_DB_BROKER_TOKEN',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE',
)


class _Account(AccountBase):
    async def authenticate(self, credential):  # pragma: no cover - unused
        return None


# ---------------------------------------------------------------------------
# Throwaway PKI (cryptography first, openssl CLI second, otherwise skip)
# ---------------------------------------------------------------------------


def _mint_with_cryptography(directory):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)

    def write_key(key, path):
        path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )

    def make_ca(name):
        key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f'rr2203 throwaway {name}')])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(
                    digital_signature=False,
                    content_commitment=False,
                    key_encipherment=False,
                    data_encipherment=False,
                    key_agreement=False,
                    key_cert_sign=True,
                    crl_sign=True,
                    encipher_only=False,
                    decipher_only=False,
                ),
                critical=True,
            )
            .sign(key, hashes.SHA256())
        )
        return key, cert

    ca_key, ca_cert = make_ca('ca')
    other_key, other_cert = make_ca('other-ca')

    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'localhost')]))
        .issuer_name(ca_cert.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=1))
        # DNS name only, deliberately NO IP SAN: https://127.0.0.1 is a wrong-hostname case.
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost')]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    paths = SimpleNamespace(
        ca=directory / 'ca.pem',
        other_ca=directory / 'other-ca.pem',
        cert=directory / 'server.pem',
        key=directory / 'server.key',
    )
    paths.ca.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    paths.other_ca.write_bytes(other_cert.public_bytes(serialization.Encoding.PEM))
    paths.cert.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    write_key(leaf_key, paths.key)
    return paths


def _mint_with_openssl(directory):
    openssl = shutil.which('openssl')
    if not openssl:
        raise FileNotFoundError('openssl')

    def run(*args):
        subprocess.run([openssl, *args], cwd=directory, check=True, capture_output=True)

    for name in ('ca', 'other-ca'):
        run(
            'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
            '-keyout', f'{name}.key', '-out', f'{name}.pem', '-days', '1', '-subj', f'/CN=rr2203 throwaway {name}',
            '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
        )  # fmt: skip
    run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'server.key',
        '-out', 'server.csr', '-subj', '/CN=localhost')  # fmt: skip
    (directory / 'server.ext').write_text(
        'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n'
    )
    run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
        '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext')  # fmt: skip
    return SimpleNamespace(
        ca=directory / 'ca.pem',
        other_ca=directory / 'other-ca.pem',
        cert=directory / 'server.pem',
        key=directory / 'server.key',
    )


@pytest.fixture(scope='module')
def pki(tmp_path_factory):
    """A throwaway CA, a second unrelated CA, and a ``localhost``-only server certificate."""
    directory = tmp_path_factory.mktemp('rr-db-broker-pki')
    try:
        return _mint_with_cryptography(directory)
    except ImportError:
        pass
    try:
        return _mint_with_openssl(directory)
    except (FileNotFoundError, subprocess.CalledProcessError):
        pytest.skip('neither the cryptography package nor the openssl command can mint a throwaway CA')


# ---------------------------------------------------------------------------
# Recording servers
# ---------------------------------------------------------------------------


class _Server:
    """A threaded HTTP(S) server that records every request it receives."""

    def __init__(self, respond, *, tls_paths=None, bind='127.0.0.1'):
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _serve(self):
                length = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(length) if length else b''
                outer.requests.append(
                    {
                        'method': self.command,
                        'path': self.path,
                        'carried_token': self.headers.get('Authorization') == f'Bearer {BROKER_TOKEN}',
                        'body': body,
                    }
                )
                status, headers, payload = respond(self)
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value)
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = _serve

        self._server = ThreadingHTTPServer((bind, 0), Handler)
        if tls_paths is not None:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(str(tls_paths.cert), str(tls_paths.key))
            self._server.socket = context.wrap_socket(self._server.socket, server_side=True)
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={'poll_interval': 0.02}, daemon=True)
        self._thread.start()

    def close(self):
        self._server.shutdown()
        self._server.server_close()


def _json(status, payload):
    return status, {'Content-Type': 'application/json'}, json.dumps(payload).encode()


@pytest.fixture
def servers():
    """Servers started by a test; all are shut down at teardown."""
    started: list[_Server] = []

    def start(respond, **kwargs):
        server = _Server(respond, **kwargs)
        started.append(server)
        return server

    yield start
    for server in started:
        server.close()


class _CountingProxy:
    """A TCP listener that only counts connections (an ambient proxy that must stay unused)."""

    def __init__(self):
        self.connections = 0
        self._sock = socket.socket()
        self._sock.bind(('127.0.0.1', 0))
        self._sock.listen(8)
        self.port = self._sock.getsockname()[1]
        self._stop = False
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        self._sock.settimeout(0.2)
        while not self._stop:
            try:
                conn, _ = self._sock.accept()
            except (socket.timeout, OSError):
                continue
            self.connections += 1
            conn.close()

    def close(self):
        self._stop = True
        self._thread.join(2)
        self._sock.close()


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


@pytest.fixture
def broker_env(monkeypatch, pki):
    """Configure the process like a deployment: broker URL + token, CA bundle via SSL_CERT_FILE."""
    for name in _ENV_TO_CLEAR:
        monkeypatch.delenv(name, raising=False)
    # urllib's process-wide default opener (``urlopen``) builds its TLS context once, at the first
    # call, and keeps the CA bundle it found then. Reset it so each test starts from the environment
    # it sets up, whatever ran before. (A client that builds its own opener is unaffected.)
    monkeypatch.setattr(urllib.request, '_opener', None)
    monkeypatch.setenv('ROCKETRIDE_DB_BROKER_TOKEN', BROKER_TOKEN)
    monkeypatch.setenv('SSL_CERT_FILE', str(pki.ca))

    def point_at(url, *, ca=None):
        monkeypatch.setenv('ROCKETRIDE_DB_BROKER_URL', url)
        if ca is not None:
            monkeypatch.setenv('SSL_CERT_FILE', str(ca))

    return point_at


def _resolve(tenant='org-live-1'):
    return asyncio.run(_Account().resolve_db_dsn(tenant))


def _good_broker(handler):
    return _json(200, {'database': 't_t1', 'role': 'role_t1', 'dsn': GOOD_DSN, 'created': False})


def _exception_text(exc: BaseException) -> str:
    """Every message in an exception chain, plus reprs, as one string."""
    seen, parts = set(), []
    pending = [exc]
    while pending:
        current = pending.pop()
        if current is None or id(current) in seen:
            continue
        seen.add(id(current))
        parts.append(f'{type(current).__name__}: {current}')
        parts.append(repr(current))
        pending.extend([current.__cause__, current.__context__])
    return '\n'.join(parts)


# ---------------------------------------------------------------------------
# Positive control: the harness itself works
# ---------------------------------------------------------------------------


def test_https_broker_with_trusted_ca_returns_the_dsn(servers, pki, broker_env):
    """Control: with the right CA and host name the same listener answers.

    Every refusal below is only meaningful because this passes.
    """
    broker = servers(_good_broker, tls_paths=pki)
    broker_env(f'https://localhost:{broker.port}/provision')

    assert _resolve() == GOOD_DSN
    assert len(broker.requests) == 1
    assert broker.requests[0]['carried_token']


# ---------------------------------------------------------------------------
# Redirects: refused, nothing reaches the target
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('status', [301, 302, 303, 307, 308])
@pytest.mark.parametrize('target', ['http', 'https', 'http-0.0.0.0'])
def test_redirect_is_refused_and_no_request_reaches_the_target(servers, pki, broker_env, status, target):
    """The token goes to the configured broker only.

    A redirect from the broker must neither be followed nor have its body
    accepted as the broker's answer. ``http`` is the https -> http downgrade;
    ``https`` is a different origin on the same host; ``http-0.0.0.0`` is a
    plain-http origin addressed by an address outside the loopback allow-list
    (``0.0.0.0`` reaches this machine, so the test needs no network).
    """
    answered_by_target = _json(
        200,
        {'dsn': 'postgresql://attacker:pw@elsewhere.invalid:5432/stolen?sslmode=disable'},
    )
    landing = servers(lambda handler: answered_by_target, tls_paths=pki if target == 'https' else None)
    host = {'http': '127.0.0.1', 'https': 'localhost', 'http-0.0.0.0': '0.0.0.0'}[target]  # noqa: S104
    scheme = 'https' if target == 'https' else 'http'
    location = f'{scheme}://{host}:{landing.port}/captured'

    broker = servers(lambda handler: (status, {'Location': location}, b''), tls_paths=pki)
    broker_env(f'https://localhost:{broker.port}/provision')

    with pytest.raises(RuntimeError) as raised:
        _resolve()

    assert landing.requests == [], 'a redirect target received a request from the broker client'
    assert len(broker.requests) == 1, 'the broker must be asked exactly once; a redirect is not retried'
    text = _exception_text(raised.value)
    assert BROKER_TOKEN not in text
    assert 'attacker' not in text, 'the redirected body must not be treated as the broker answer'


def test_plain_http_loopback_broker_redirect_is_refused_too(servers, broker_env):
    """The localhost-only http exemption (dev rig) gets no redirect exemption either."""
    landing = servers(lambda handler: _json(200, {'dsn': GOOD_DSN}))
    broker = servers(lambda handler: (302, {'Location': f'http://127.0.0.1:{landing.port}/captured'}, b''))
    broker_env(f'http://localhost:{broker.port}/provision')

    with pytest.raises(RuntimeError):
        _resolve()

    assert landing.requests == []


# ---------------------------------------------------------------------------
# Certificates
# ---------------------------------------------------------------------------


def test_certificate_for_another_host_name_is_refused(servers, pki, broker_env):
    """The listener's certificate names ``localhost`` only; ``127.0.0.1`` must not be accepted for it."""
    broker = servers(_good_broker, tls_paths=pki)
    broker_env(f'https://127.0.0.1:{broker.port}/provision')

    with pytest.raises(RuntimeError) as raised:
        _resolve()

    assert broker.requests == [], 'the token was sent although the certificate did not match the host'
    assert BROKER_TOKEN not in _exception_text(raised.value)


def test_certificate_from_an_untrusted_ca_is_refused(servers, pki, broker_env):
    """A certificate that chains to a CA outside the configured bundle is refused."""
    broker = servers(_good_broker, tls_paths=pki)
    broker_env(f'https://localhost:{broker.port}/provision', ca=pki.other_ca)

    with pytest.raises(RuntimeError) as raised:
        _resolve()

    assert broker.requests == [], 'the token was sent although the certificate chain was untrusted'
    assert BROKER_TOKEN not in _exception_text(raised.value)


# ---------------------------------------------------------------------------
# Ambient proxy
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('variable', ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'http_proxy'])
def test_ambient_proxy_is_ignored(servers, pki, broker_env, monkeypatch, variable):
    """A proxy named by the process environment never sees the broker call.

    The environment of a cloud engine can be influenced by operators' tooling
    and by sidecars; a proxy that terminates TLS would receive the bearer token.
    The broker is addressed directly, as configured.
    """
    proxy = _CountingProxy()
    try:
        broker = servers(_good_broker, tls_paths=pki)
        broker_env(f'https://localhost:{broker.port}/provision')
        monkeypatch.setenv(variable, f'http://127.0.0.1:{proxy.port}')

        result = _resolve()
    finally:
        proxy.close()

    assert proxy.connections == 0, f'{variable} was honoured: the broker call went to the proxy'
    assert result == GOOD_DSN
    assert len(broker.requests) == 1


# ---------------------------------------------------------------------------
# No secrets in failure text
# ---------------------------------------------------------------------------


def _echoing_broker(handler):
    """A broker that fails and echoes the secrets it was sent (a careless proxy or WAF would)."""
    return _json(
        500,
        {
            'error': f'denied bearer={BROKER_TOKEN}',
            'dsn': GOOD_DSN,
            'detail': f'postgresql://role_t1:{DSN_PASSWORD}@pooler.internal:5432/t_t1',
        },
    )


_FAILURES = {
    'server-error-echoing-secrets': lambda pki: (_echoing_broker, None),
    'conflict-409': lambda pki: (lambda h: (409, {}, f'retained {BROKER_TOKEN}'.encode()), None),
    'not-json': lambda pki: (lambda h: (200, {}, f'oops {BROKER_TOKEN} {DSN_PASSWORD}'.encode()), None),
    'no-dsn-key': lambda pki: (lambda h: _json(200, {'database': 'x', 'note': DSN_PASSWORD}), None),
    'non-postgres-dsn': lambda pki: (lambda h: _json(200, {'dsn': f'mysql://u:{DSN_PASSWORD}@h/db'}), None),
    'dsn-not-a-url': lambda pki: (lambda h: _json(200, {'dsn': f'host=h user=u password={DSN_PASSWORD}'}), None),
}


@pytest.mark.parametrize('failure', sorted(_FAILURES))
def test_failure_text_never_carries_a_secret(servers, pki, broker_env, failure):
    """Neither the bearer token nor any DSN password may appear in an exception, however it is chained."""
    respond, _ = _FAILURES[failure](pki)
    broker = servers(respond, tls_paths=pki)
    broker_env(f'https://localhost:{broker.port}/provision')

    with pytest.raises(Exception) as raised:
        _resolve()

    text = _exception_text(raised.value)
    assert BROKER_TOKEN not in text
    assert DSN_PASSWORD not in text


@pytest.mark.parametrize(
    'url_template',
    [
        'https://svc:{pw}@localhost:{port}/provision',
        'https://svc:{pw}@localhost:notaport/provision',
        'https://svc:{pw}@:{port}/provision',
        'http://svc:{pw}@evil.example.invalid/provision',
        'ftp://svc:{pw}@localhost/provision',
        'https://localhost:{port}/provision#{pw}',
    ],
)
def test_unusable_broker_url_never_echoes_userinfo(servers, pki, broker_env, url_template):
    """A malformed or unsafe broker URL is refused without repeating the secret it embeds."""
    broker = servers(_good_broker, tls_paths=pki)
    broker_env(url_template.format(pw=URL_PASSWORD, port=broker.port))

    try:
        _resolve()
    except Exception as exc:  # any refusal is acceptable here; the text is what is checked
        text = _exception_text(exc)
        assert URL_PASSWORD not in text
        assert BROKER_TOKEN not in text


def test_unreachable_broker_never_echoes_secrets(broker_env):
    """Connection refused: the error is reported without the token."""
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        free_port = probe.getsockname()[1]
    broker_env(f'https://localhost:{free_port}/provision')

    with pytest.raises(RuntimeError) as raised:
        _resolve()

    assert BROKER_TOKEN not in _exception_text(raised.value)
