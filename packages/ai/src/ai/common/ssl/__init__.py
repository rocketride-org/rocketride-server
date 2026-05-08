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

Usage:
    import ai.common.ssl  # noqa: F401 - patches default SSL context

Import this once, early, in any module that triggers HTTPS downloads.
The `ai.common.models` package imports it at the top of its __init__.py,
so any model loader is covered transitively.

If truststore can't be installed or injected (e.g. very old Python), this
module falls back to pointing OpenSSL at certifi's bundle — better than
the partial Windows store, but won't pick up corporate CAs.
"""

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

try:
    import truststore

    truststore.inject_into_ssl()
except Exception:
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
        pass
