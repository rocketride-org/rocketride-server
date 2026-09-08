# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""
SSL trust store integration.

Embedded Python on Windows ships a default SSL context that loads only a
narrow subset of the Windows ROOT store (often <30 CAs in practice on
locked-down corporate machines). That breaks any model loader that
downloads weights from a public CDN — TLS validation fails with
"unable to get local issuer certificate" because the CA that signed the
server's chain isn't in the loaded subset.

This module installs `truststore` and patches Python's default SSL context
to use the OS trust store directly (SChannel on Windows, SecureTransport on
macOS, OpenSSL system roots on Linux). Effects:
  - All public CAs in the OS store are trusted, not just the subset
    `load_default_certs()` exposes.
  - Corporate root CAs deployed via Group Policy / MDM are picked up
    automatically — needed for any environment with TLS-intercepting proxies
    (Zscaler, Netskope, BlueCoat, etc.).
  - urllib, requests, httpx, and anything using a default SSL context all
    benefit from the same patch — no per-callsite changes needed.

Scope: this patches the Python `ssl` layer. Downloads that shell out to pip
(e.g. a `pip install <url>` inside a loader) use pip's own bundled CA store
and are NOT covered here.

Usage:
    from ai.common.ssl import ensure
    ensure()  # idempotent; performs the injection once per process

Injection is process-global, so `ensure()` is called from
``BaseLoader._ensure_dependencies`` — the local-mode chokepoint every
``load()`` passes through — rather than at package import. Remote-mode
dispatch processes never load ML libraries or download weights, so they no
longer pay for an injection they don't use.

If truststore can't be installed or injected (e.g. very old Python), this
falls back to pointing OpenSSL at certifi's bundle — better than the partial
Windows store, but won't pick up corporate CAs.
"""

import os
import threading

from depends import depends
from engLib import debug

# Process-global one-shot guard: injection mutates the default SSL context for
# the whole interpreter, so it must run exactly once per process. The lock makes
# a concurrent caller wait for the first injection to finish instead of racing
# ahead and downloading weights through a context that is not patched yet.
_lock = threading.Lock()
_attempted = False


def ensure() -> None:
    """Patch Python's default SSL context to use the OS trust store.

    Idempotent and safe to call on every model load: the work runs once per
    process. Callers arriving while the first injection is still in flight block
    until it completes, so none of them proceeds on a half-patched context.
    """
    global _attempted
    if _attempted:
        return

    with _lock:
        # Re-check under the lock: another thread may have finished the
        # injection while this one was waiting for it.
        if _attempted:
            return
        try:
            _install_and_inject()
        finally:
            # Record the attempt even when it failed, so a broken environment
            # is not re-run through the install lock on every later load().
            _attempted = True


def _install_and_inject() -> None:
    """Install truststore and patch the SSL context, or fall back to certifi."""
    requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'

    try:
        # Inside the guarded block on purpose: a failed install has to reach the
        # certifi fallback below rather than propagate out of ensure().
        depends(requirements)

        import truststore

        truststore.inject_into_ssl()
    except Exception as exc:
        # Fallback: point Python at certifi's CA bundle. Catches the "embedded
        # Python's default trust store is too small" case but won't help with
        # corporate TLS interception. Better than nothing.
        try:
            import certifi

            os.environ.setdefault('SSL_CERT_FILE', certifi.where())
            os.environ.setdefault('REQUESTS_CA_BUNDLE', certifi.where())
        except Exception:
            # Both truststore and certifi fallback failed. Leave the default SSL
            # context untouched — downstream HTTPS calls will surface their own
            # error with a real traceback if validation fails.
            debug(f'ai.common.ssl: trust store injection unavailable: {exc}')
