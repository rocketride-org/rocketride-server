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

# ------------------------------------------------------------------------------
# ApprovalNotifier -- sends notifications when an approval is requested.
#
# Supports three channels: 'webhook', 'log', and 'none'.
# The webhook channel prepares a JSON payload and POSTs it to the configured
# URL.  The HTTP call is fire-and-forget with a short timeout so it does not
# block the pipeline hot path.  Delivery failures are logged but never raise.
# ------------------------------------------------------------------------------

import json
import logging
import urllib.request
from typing import Any, Dict, Optional
from urllib.parse import urlparse


logger = logging.getLogger(__name__)

# Only allow http(s) webhook URLs to mitigate SSRF
_ALLOWED_SCHEMES = {'http', 'https'}


class ApprovalNotifier:
    """Send human-approval notifications through configurable channels."""

    def __init__(self, notification_type: str = 'log', webhook_url: Optional[str] = None) -> None:
        """Initialise the notifier.

        Args:
            notification_type: One of 'webhook', 'log', or 'none'.
            webhook_url: Required when *notification_type* is 'webhook'.

        Raises:
            ValueError: On invalid *notification_type* or unsafe *webhook_url*.
        """
        if notification_type not in ('webhook', 'log', 'none'):
            raise ValueError(f'Invalid notification_type: {notification_type!r}. Must be webhook, log, or none.')

        if notification_type == 'webhook':
            self._validate_webhook_url(webhook_url)

        self._notification_type = notification_type
        self._webhook_url = webhook_url

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def notify(self, approval_request: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Dispatch a notification for the given approval request.

        Returns:
            The prepared webhook payload dict when channel is 'webhook',
            a log-entry dict when channel is 'log', or ``None`` for 'none'.
        """
        if self._notification_type == 'webhook':
            return self.notify_webhook(self._webhook_url, approval_request)
        if self._notification_type == 'log':
            return self.notify_log(approval_request)
        return None

    def notify_webhook(self, url: Optional[str], approval_request: Dict[str, Any]) -> Dict[str, Any]:
        """Prepare a webhook POST payload and send it.

        The HTTP call uses a short timeout (10 s) so it does not block the
        pipeline hot path.  Delivery failures are logged but never raised --
        the structured payload is always returned so callers (and tests) can
        inspect it regardless of network outcome.

        Args:
            url: The webhook endpoint URL.
            approval_request: The approval request dict.

        Returns:
            The payload that was POSTed (or attempted).
        """
        self._validate_webhook_url(url)

        payload: Dict[str, Any] = {
            'event': 'approval_requested',
            'approval_id': approval_request.get('approval_id', ''),
            'item_id': approval_request.get('item_id', ''),
            'content_preview': approval_request.get('content_preview', ''),
            'metadata': approval_request.get('metadata', {}),
            'status': approval_request.get('status', 'pending'),
            'timeout_seconds': approval_request.get('timeout_seconds', 0),
            'timeout_action': approval_request.get('timeout_action', 'approve'),
            'webhook_url': url,
        }

        body = json.dumps(payload, default=str).encode('utf-8')
        req = urllib.request.Request(
            url,
            data=body,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )

        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                logger.info('Approval webhook delivered for %s -> %s (HTTP %s)', payload['approval_id'], url, resp.status)
        except Exception:
            logger.exception('Failed to deliver approval webhook for %s -> %s', payload['approval_id'], url)

        return payload

    def notify_log(self, approval_request: Dict[str, Any]) -> Dict[str, Any]:
        """Log the pending approval for monitoring and return a log-entry dict."""
        entry: Dict[str, Any] = {
            'event': 'approval_requested',
            'approval_id': approval_request.get('approval_id', ''),
            'item_id': approval_request.get('item_id', ''),
            'status': approval_request.get('status', 'pending'),
            'content_preview': approval_request.get('content_preview', ''),
        }

        logger.info(
            'Approval requested: id=%s item=%s status=%s',
            entry['approval_id'],
            entry['item_id'],
            entry['status'],
        )

        return entry

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _validate_webhook_url(url: Optional[str]) -> None:
        """Reject URLs that could enable SSRF (non-http(s), internal IPs, etc.)."""
        if not url:
            raise ValueError('webhook_url is required for webhook notifications')

        parsed = urlparse(url)
        if parsed.scheme not in _ALLOWED_SCHEMES:
            raise ValueError(f'Webhook URL scheme must be http or https, got: {parsed.scheme!r}')

        host = parsed.hostname or ''
        if not host:
            raise ValueError('Webhook URL must include a hostname')

        # Block obvious internal/loopback addresses
        _blocked = {'localhost', '127.0.0.1', '::1', '0.0.0.0'}
        if host in _blocked:
            raise ValueError(f'Webhook URL must not point to a loopback/internal address: {host!r}')

        # Block private-range IPv4 prefixes (RFC 1918 / link-local)
        if host.startswith(('10.', '192.168.', '169.254.')):
            raise ValueError(f'Webhook URL must not point to a private network address: {host!r}')

        # 172.16.0.0 - 172.31.255.255
        if host.startswith('172.'):
            parts = host.split('.')
            if len(parts) >= 2:
                try:
                    second_octet = int(parts[1])
                except (ValueError, IndexError):
                    second_octet = -1
                if 16 <= second_octet <= 31:
                    raise ValueError(f'Webhook URL must not point to a private network address: {host!r}')
