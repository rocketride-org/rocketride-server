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

"""Outbound notifications for new approval requests.

Two channels are supported in PR A:

  * ``log``   — write a structured line via the supplied logger callable.
  * ``webhook`` — POST a JSON body to a URL.

Webhook URLs are validated up-front to block SSRF: private/loopback/link-local
ranges are forbidden by default for both IPv4 *and* IPv6. PR #542 only
covered IPv4 — IPv6 ULA / link-local / loopback were unhandled, which the
issue explicitly called out.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import socket
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
from urllib import error as urlerror
from urllib import request as urlrequest
from urllib.parse import urlparse

from .models import ApprovalRequest


_DEFAULT_LOGGER = logging.getLogger('rocketride.approvals')


@dataclass
class NotifierConfig:
    """Channel configuration for ``ApprovalNotifier``.

    Empty values disable a channel — both empty means notifications are no-ops,
    which is fine: callers may rely solely on REST polling.
    """

    log_channel_enabled: bool = True
    webhook_url: Optional[str] = None
    webhook_timeout_seconds: float = 5.0
    webhook_headers: Dict[str, str] = field(default_factory=dict)
    allow_private_webhook_hosts: bool = False  # opt-in for self-hosted setups


class ApprovalNotifier:
    """Sends notifications when a new approval is created.

    Designed to fail-soft: a misbehaving webhook must not crash the pipeline
    or block a decision. Errors are logged and swallowed.
    """

    def __init__(
        self,
        config: Optional[NotifierConfig] = None,
        *,
        logger: Optional[logging.Logger] = None,
        url_opener: Optional[Callable[..., Any]] = None,
    ) -> None:
        """Configure channels.

        Args:
            config: channel configuration; defaults are safe (log-only).
            logger: where the log channel writes; defaults to a module logger.
            url_opener: dependency-injection seam used by tests to avoid
                real network I/O. Should accept ``(request, timeout=...)`` and
                return a context-manager-compatible response object.
        """
        self._config = config or NotifierConfig()
        self._logger = logger or _DEFAULT_LOGGER
        self._url_opener = url_opener or urlrequest.urlopen
        self._lock = threading.Lock()

    @property
    def config(self) -> NotifierConfig:
        """Active configuration (read-only handle)."""
        return self._config

    def notify(self, request: ApprovalRequest) -> List[str]:
        """Fan out a notification for ``request`` to all enabled channels.

        Returns the list of channel names that delivered successfully. Failures
        on individual channels are logged but never raised.
        """
        delivered: List[str] = []

        if self._config.log_channel_enabled:
            try:
                self._notify_log(request)
                delivered.append('log')
            except Exception as exc:  # pragma: no cover — defensive only
                self._logger.warning('approval log channel failed: %s', exc)

        if self._config.webhook_url:
            try:
                self._notify_webhook(request)
                delivered.append('webhook')
            except Exception as exc:
                self._logger.warning('approval webhook to %s failed: %s', self._config.webhook_url, exc)

        return delivered

    def _notify_log(self, request: ApprovalRequest) -> None:
        self._logger.info(
            'approval pending: id=%s pipeline=%s node=%s profile=%s',
            request.approval_id,
            request.pipeline_id,
            request.node_id,
            request.profile,
        )

    def _notify_webhook(self, request: ApprovalRequest) -> None:
        url = self._config.webhook_url
        if not url:
            return
        validate_webhook_url(url, allow_private=self._config.allow_private_webhook_hosts)

        body = json.dumps({'event': 'approval.created', 'request': request.to_dict()}).encode('utf-8')
        headers = {'Content-Type': 'application/json'}
        headers.update(self._config.webhook_headers)
        req = urlrequest.Request(url, data=body, method='POST', headers=headers)

        try:
            with self._url_opener(req, timeout=self._config.webhook_timeout_seconds) as resp:
                # Drain the response so the connection releases promptly.
                resp.read()
        except urlerror.URLError as exc:
            raise WebhookDeliveryError(f'webhook delivery failed: {exc}') from exc


class WebhookDeliveryError(RuntimeError):
    """Raised when the outbound webhook cannot be delivered."""


class SSRFValidationError(ValueError):
    """Raised when a webhook URL targets a forbidden address."""


def validate_webhook_url(url: str, *, allow_private: bool = False) -> None:
    """Reject URLs that would let an attacker target internal services.

    Resolves the hostname and inspects every returned IP — DNS rebinding
    attacks fail because the actual ``urlopen`` will resolve again, but having
    *any* private address in the answer is a strong heuristic for misuse.

    Args:
        url: the URL to validate. Must use http or https.
        allow_private: when True, private/loopback/link-local addresses are
            permitted. Self-hosted operators may set this to point at internal
            review services (e.g. an on-premises tracker).

    Raises:
        SSRFValidationError if the URL is malformed, uses a non-HTTP scheme,
        or resolves to a forbidden range.
    """
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https'):
        raise SSRFValidationError(f'webhook URL must use http or https; got {parsed.scheme!r}')
    if not parsed.hostname:
        raise SSRFValidationError(f'webhook URL is missing a hostname: {url!r}')

    host = parsed.hostname
    addresses = _resolve_host(host)
    if not addresses:
        raise SSRFValidationError(f'webhook host {host!r} did not resolve to any address')

    forbidden: List[str] = []
    for address in addresses:
        if _is_address_forbidden(address) and not allow_private:
            forbidden.append(address)

    if forbidden:
        raise SSRFValidationError(f'webhook host {host!r} resolves to forbidden address(es) {forbidden!r}; set allow_private=True if this targets an internal service on a trusted network')


def _resolve_host(host: str) -> List[str]:
    """Resolve ``host`` to all IPv4+IPv6 addresses; tolerates lookup failure.

    Lookup failure returns an empty list; the caller treats that as forbidden.
    A direct IP literal is parsed and returned as-is.
    """
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        pass

    try:
        results = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return []

    addresses: List[str] = []
    for family, _socktype, _proto, _canon, sockaddr in results:
        if family in (socket.AF_INET, socket.AF_INET6):
            addresses.append(sockaddr[0])
    return addresses


def _is_address_forbidden(address: str) -> bool:
    """Return True if ``address`` falls in any private/loopback/link-local/reserved range.

    Covers IPv4 and IPv6. The IPv6 cases (loopback ::1, link-local fe80::/10,
    unique-local fc00::/7, IPv4-mapped/embedded) were missing from PR #542.
    """
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return True  # unparseable: treat as forbidden, fail-closed

    if ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved:
        return True
    if ip.is_unspecified or ip.is_multicast:
        return True

    if isinstance(ip, ipaddress.IPv6Address):
        # IPv4-mapped (::ffff:0:0/96) and IPv4-compat addresses bypass the IPv4
        # checks above unless we re-validate the embedded IPv4. ipaddress
        # treats some of these as "private" already, but be explicit.
        if ip.ipv4_mapped is not None and _is_address_forbidden(str(ip.ipv4_mapped)):
            return True
        if ip.sixtofour is not None and _is_address_forbidden(str(ip.sixtofour)):
            return True

    return False
