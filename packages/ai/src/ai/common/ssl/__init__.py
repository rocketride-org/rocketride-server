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

from depends import depends
from engLib import debug

# Process-global one-shot guard: injection mutates the default SSL context for
# the whole interpreter, so it must run exactly once per process.
_injected = False


def ensure() -> None:
    """Patch Python's default SSL context to use the OS trust store.

    Idempotent and safe to call on every model load: the work runs once per
    process, guarded by the module-level ``_injected`` flag.
    """
    global _injected
    if _injected:
        return
    # Set the guard up front so a failure below is not retried (and re-run
    # through the install lock) on every subsequent load().
    _injected = True

    requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
    depends(requirements)

    try:
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
