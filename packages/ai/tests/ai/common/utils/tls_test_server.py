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
    """``/slow-headers``: one header byte per 100 ms. ``/slow-body``: one body byte per 100 ms.

    Sets the server's ``trickling`` event once the response starts trickling.
    """

    def log_message(self, *args):
        pass

    def do_GET(self):
        try:
            if self.path == '/slow-headers':
                self.wfile.write(b'HTTP/1.1 200 OK\r\nX-Pad: ')
                self.wfile.flush()
                self.server.trickling.set()
                for _ in range(100):
                    self.wfile.write(b'a')
                    self.wfile.flush()
                    time.sleep(0.1)
            else:
                self.send_response(200)
                self.send_header('Content-Length', '100')
                self.end_headers()
                self.server.trickling.set()
                for _ in range(100):
                    self.wfile.write(b'x')
                    self.wfile.flush()
                    time.sleep(0.1)
        except OSError:
            pass  # the client gave up
        self.close_connection = True


class TrickleServer(ThreadingHTTPServer):
    """Serves :class:`TrickleHandler` on 127.0.0.1; ``trickling`` is set once a response starts trickling."""

    def __init__(self) -> None:
        super().__init__(('127.0.0.1', 0), TrickleHandler)
        self.trickling = threading.Event()


def serve_https(cert: str, key: str) -> Tuple[TrickleServer, int]:
    """Serve :class:`TrickleHandler` over TLS on 127.0.0.1; returns (server, port). Call ``shutdown()``."""
    httpd = TrickleServer()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


class SlowHandshakeServer:
    """A TCP server that answers a TLS ClientHello with a record header, then one byte per 100 ms.

    The client's handshake blocks reading that record; ``stalled`` is set once
    the header is sent. :meth:`close` (or leaving the ``with`` block) stops the
    accept loop and every trickle, and joins their threads.
    """

    def __init__(self) -> None:
        self._listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._listener.bind(('127.0.0.1', 0))
        self._listener.listen()
        # Bounded, so the accept loop sees ``_stop`` without a wake-up
        # connection (closing a socket does not wake ``accept`` on Linux).
        self._listener.settimeout(0.1)
        self.port = self._listener.getsockname()[1]
        self.stalled = threading.Event()
        self._stop = threading.Event()
        self._acceptor = threading.Thread(target=self._serve, daemon=True)
        self._trickles = []
        self._acceptor.start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self._listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            trickle = threading.Thread(target=self._trickle, args=(conn,), daemon=True)
            self._trickles.append(trickle)
            trickle.start()

    def _hello(self, conn: socket.socket) -> bytes:
        """The ClientHello, or nothing once the server stops or the client leaves.

        The wait is bounded like the accept's: a client that connects and
        never speaks must not hold its worker, and neither a shutdown nor a
        close from another thread wakes a blocked ``recv`` on every platform.
        """
        conn.settimeout(0.1)
        while not self._stop.is_set():
            try:
                return conn.recv(4096)
            except socket.timeout:
                continue
        return b''

    def _trickle(self, conn: socket.socket) -> None:
        try:
            if not self._hello(conn):
                return
            conn.settimeout(None)
            conn.sendall(b'\x16\x03\x03\x40\x00')  # a 16 KB handshake record follows...
            self.stalled.set()
            for _ in range(100):
                conn.sendall(b'\x00')  # ...very slowly
                if self._stop.wait(0.1):
                    return
        except OSError:
            pass
        finally:
            conn.close()

    def close(self) -> None:
        """Stop accepting and trickling; join the threads (bounded) and close the listener."""
        self._stop.set()
        self._acceptor.join(5)
        for trickle in self._trickles:
            trickle.join(5)
        self._listener.close()

    def __enter__(self) -> 'SlowHandshakeServer':
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()


def serve_slow_handshake() -> SlowHandshakeServer:
    """Start a :class:`SlowHandshakeServer` on 127.0.0.1; close it when done (it is a context manager)."""
    return SlowHandshakeServer()
