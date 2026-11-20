# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Local TLS servers for transport tests: a throwaway self-signed cert for 127.0.0.1.

No engine imports, so node tests can load it by path as well
(``nodes/test/scraper_beautifulsoup/test_fetch.py``).
"""

from __future__ import annotations

import datetime
import ipaddress
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def make_cert(directory: Path) -> Tuple[str, str]:
    """Write a self-signed cert and key for ``127.0.0.1`` into ``directory``; returns (cert, key) paths."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, '127.0.0.1')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(hours=1))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    cert_path = directory / 'cert.pem'
    key_path = directory / 'key.pem'
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    return str(cert_path), str(key_path)


class TrickleHandler(BaseHTTPRequestHandler):
    """``/slow-headers``: one header byte per 100 ms. ``/slow-body``: one body byte per 100 ms."""

    def log_message(self, *args):
        pass

    def do_GET(self):
        try:
            if self.path == '/slow-headers':
                self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Pad: ')
                self.wfile.flush()
                for _ in range(100):
                    self.wfile.write(b'a')
                    self.wfile.flush()
                    time.sleep(0.1)
            else:
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.end_headers()
                for _ in range(100):
                    self.wfile.write(b'x')
                    self.wfile.flush()
                    time.sleep(0.1)
        except OSError:
            pass  # the client gave up
        self.close_connection = True


def serve_https(cert: str, key: str) -> Tuple[ThreadingHTTPServer, int]:
    """Serve :class:`TrickleHandler` over TLS on 127.0.0.1; returns (server, port). Call ``shutdown()``."""
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), TrickleHandler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def serve_slow_handshake() -> Tuple[socket.socket, int]:
    """A TCP server that answers a TLS ClientHello with a record header, then one byte per 100 ms.

    The client's handshake blocks reading that record. Returns (listener, port); close the listener.
    """
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(('127.0.0.1', 0))
    listener.listen()

    def serve() -> None:
        while True:
            try:
                conn, _ = listener.accept()
            except OSError:
                return
            threading.Thread(target=trickle, args=(conn,), daemon=True).start()

    def trickle(conn: socket.socket) -> None:
        try:
            conn.recv(4096)  # the ClientHello
            conn.sendall(b'\x16\x03\x03\x40\x00')  # a 16 KB handshake record follows...
            for _ in range(100):
                conn.sendall(b'\x00')  # ...very slowly
                time.sleep(0.1)
        except OSError:
            pass
        finally:
            conn.close()

    threading.Thread(target=serve, daemon=True).start()
    return listener, listener.getsockname()[1]
