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

"""Throwaway PKI for the database acceptance tests.

Mints, at test time and under a caller-supplied directory only:

* a CA and a second, unrelated CA (for "right CA / wrong CA" cases);
* a server certificate signed by the first CA, naming exactly the DNS names and
  IP addresses asked for. The default is ``localhost`` only, so a connection to
  ``127.0.0.1`` is a genuine host-name mismatch.

Uses the ``cryptography`` package when importable and the ``openssl`` command
otherwise; raises :class:`PkiUnavailable` when neither can be used so callers can
skip. Keys are written 0600 inside the directory and nowhere else.
"""

from __future__ import annotations

import datetime
import shutil
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Sequence


class PkiUnavailable(RuntimeError):
    """Neither ``cryptography`` nor the ``openssl`` command is available."""


def mint(directory: Path, *, dns: Sequence[str] = ('localhost',), ips: Sequence[str] = ()) -> SimpleNamespace:
    """Create the PKI files in ``directory`` and return their paths.

    Returns a namespace with ``ca``, ``other_ca``, ``cert`` and ``key`` paths.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        return _with_cryptography(directory, tuple(dns), tuple(ips))
    except ImportError:
        pass
    try:
        return _with_openssl(directory, tuple(dns), tuple(ips))
    except (FileNotFoundError, subprocess.CalledProcessError) as e:
        raise PkiUnavailable('neither the cryptography package nor the openssl command can mint a CA') from e


def bundle(destination: Path, *sources: Path) -> Path:
    """Concatenate PEM files into one multi-CA bundle (what ``SSL_CERT_FILE`` is in a deployment)."""
    destination = Path(destination)
    destination.write_bytes(b''.join(Path(s).read_bytes() for s in sources))
    return destination


def _paths(directory: Path) -> SimpleNamespace:
    return SimpleNamespace(
        ca=directory / 'ca.pem',
        other_ca=directory / 'other-ca.pem',
        cert=directory / 'server.pem',
        key=directory / 'server.key',
    )


def _with_cryptography(directory: Path, dns: tuple, ips: tuple) -> SimpleNamespace:
    import ipaddress

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

    now = datetime.datetime.now(datetime.timezone.utc)
    start, end = now - datetime.timedelta(minutes=5), now + datetime.timedelta(days=1)

    def make_ca(name):
        key = ec.generate_private_key(ec.SECP256R1())
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f'rr2203 throwaway {name}')])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(subject)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(start)
            .not_valid_after(end)
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
    _, other_cert = make_ca('other-ca')

    names = [x509.DNSName(n) for n in dns] + [x509.IPAddress(ipaddress.ip_address(i)) for i in ips]
    leaf_key = ec.generate_private_key(ec.SECP256R1())
    leaf = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, dns[0] if dns else 'server')]))
        .issuer_name(ca_cert.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(start)
        .not_valid_after(end)
        .add_extension(x509.SubjectAlternativeName(names), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(ca_key, hashes.SHA256())
    )
    paths = _paths(directory)
    paths.ca.write_bytes(ca_cert.public_bytes(serialization.Encoding.PEM))
    paths.other_ca.write_bytes(other_cert.public_bytes(serialization.Encoding.PEM))
    paths.cert.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    paths.key.write_bytes(
        leaf_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
        )
    )
    paths.key.chmod(0o600)
    return paths


def _with_openssl(directory: Path, dns: tuple, ips: tuple) -> SimpleNamespace:
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
        '-out', 'server.csr', '-subj', f'/CN={dns[0] if dns else "server"}')  # fmt: skip
    san = ','.join([f'DNS:{n}' for n in dns] + [f'IP:{i}' for i in ips])
    (directory / 'server.ext').write_text(
        f'subjectAltName={san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n'
    )
    run('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
        '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext')  # fmt: skip
    paths = _paths(directory)
    paths.key.chmod(0o600)
    return paths
