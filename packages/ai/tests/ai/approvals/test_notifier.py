# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for ai.approvals.notifier — log + webhook channels and SSRF.

These cover the IPv6 SSRF gaps PR #542 reviewers explicitly flagged:
loopback ``::1``, link-local ``fe80::/10``, unique-local ``fc00::/7``, and
IPv4-mapped IPv6 (``::ffff:0:0/96``).
"""

import io
import logging
from unittest.mock import MagicMock

import pytest

from ai.approvals.models import ApprovalRequest, ApprovalStatus
from ai.approvals.notifier import (
    ApprovalNotifier,
    NotifierConfig,
    SSRFValidationError,
    validate_webhook_url,
)


def _make_request() -> ApprovalRequest:
    return ApprovalRequest(
        approval_id='r-1',
        pipeline_id='p-1',
        node_id='n-1',
        payload={'text': 'hi'},
        status=ApprovalStatus.PENDING,
    )


class TestSSRFValidation:
    @pytest.mark.parametrize(
        'host',
        [
            'http://127.0.0.1/hook',
            'http://localhost/hook',
            'http://10.0.0.1/hook',
            'http://192.168.1.1/hook',
            'http://172.16.0.1/hook',
            'http://169.254.169.254/latest/meta-data',  # AWS metadata
            'http://[::1]/hook',  # IPv6 loopback
            'http://[fe80::1]/hook',  # IPv6 link-local
            'http://[fc00::1]/hook',  # IPv6 unique-local
            'http://[fd12:3456:789a::1]/hook',  # IPv6 ULA range
            'http://[::ffff:127.0.0.1]/hook',  # IPv4-mapped loopback
        ],
    )
    def test_blocks_private_and_loopback_addresses(self, host):
        with pytest.raises(SSRFValidationError):
            validate_webhook_url(host)

    def test_allows_private_when_explicitly_opted_in(self):
        # Self-hosted operators may want to point at internal services.
        validate_webhook_url('http://10.0.0.5/hook', allow_private=True)

    def test_rejects_non_http_scheme(self):
        with pytest.raises(SSRFValidationError, match='http or https'):
            validate_webhook_url('file:///etc/passwd')

    def test_rejects_missing_hostname(self):
        with pytest.raises(SSRFValidationError):
            validate_webhook_url('http:///nohost')

    def test_allows_public_address(self):
        # 8.8.8.8 is a stable public address suitable for parameter validation.
        validate_webhook_url('https://8.8.8.8/hook')


class TestApprovalNotifier:
    def test_log_channel_writes_structured_line(self):
        logger = logging.getLogger('test.approvals')
        logger.handlers.clear()
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter('%(message)s'))
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)

        notifier = ApprovalNotifier(NotifierConfig(log_channel_enabled=True), logger=logger)
        delivered = notifier.notify(_make_request())
        assert delivered == ['log']
        assert 'approval pending: id=r-1' in stream.getvalue()

    def test_log_channel_disabled_is_skipped(self):
        notifier = ApprovalNotifier(NotifierConfig(log_channel_enabled=False))
        assert notifier.notify(_make_request()) == []

    def test_webhook_posts_when_configured(self):
        # Use a public-resolving hostname so SSRF validation passes;
        # the url_opener is mocked, so no network I/O actually happens.
        opener = MagicMock()
        opener.return_value.__enter__.return_value.read.return_value = b'ok'

        notifier = ApprovalNotifier(
            NotifierConfig(
                log_channel_enabled=False,
                webhook_url='https://8.8.8.8/hook',
            ),
            url_opener=opener,
        )
        delivered = notifier.notify(_make_request())
        assert delivered == ['webhook']
        opener.assert_called_once()
        request_arg = opener.call_args.args[0]
        assert request_arg.full_url == 'https://8.8.8.8/hook'
        assert request_arg.get_header('Content-type') == 'application/json'

    def test_webhook_failure_is_swallowed_and_logged(self):
        """A misbehaving webhook must never crash the pipeline."""
        opener = MagicMock(side_effect=ConnectionError('boom'))
        # Use a real public-resolving address so SSRF passes.
        notifier = ApprovalNotifier(
            NotifierConfig(
                log_channel_enabled=False,
                webhook_url='https://8.8.8.8/hook',
            ),
            url_opener=opener,
        )
        # Should not raise.
        assert notifier.notify(_make_request()) == []

    def test_webhook_to_private_address_rejected_by_default(self):
        notifier = ApprovalNotifier(
            NotifierConfig(
                log_channel_enabled=False,
                webhook_url='http://127.0.0.1/hook',
            ),
            url_opener=MagicMock(),
        )
        # SSRF blocks delivery; failure is swallowed; channel reports nothing delivered.
        assert notifier.notify(_make_request()) == []

    def test_webhook_to_private_address_allowed_with_opt_in(self):
        opener = MagicMock()
        opener.return_value.__enter__.return_value.read.return_value = b'ok'
        notifier = ApprovalNotifier(
            NotifierConfig(
                log_channel_enabled=False,
                webhook_url='http://127.0.0.1/hook',
                allow_private_webhook_hosts=True,
            ),
            url_opener=opener,
        )
        assert notifier.notify(_make_request()) == ['webhook']

    def test_silent_mode_short_circuits_all_channels(self):
        """silent=True must suppress every channel even when others are configured.

        Reviewers using a custom dashboard rely on REST polling — accidentally
        leaving log_channel_enabled=True would leak operational signal.
        """
        opener = MagicMock()
        notifier = ApprovalNotifier(
            NotifierConfig(
                log_channel_enabled=True,
                webhook_url='https://8.8.8.8/hook',
                silent=True,
            ),
            url_opener=opener,
        )
        delivered = notifier.notify(_make_request())
        assert delivered == []
        opener.assert_not_called()

    def test_custom_headers_are_attached(self):
        opener = MagicMock()
        opener.return_value.__enter__.return_value.read.return_value = b'ok'
        notifier = ApprovalNotifier(
            NotifierConfig(
                log_channel_enabled=False,
                webhook_url='https://8.8.8.8/hook',
                webhook_headers={'X-Tenant': 'rocketride'},
            ),
            url_opener=opener,
        )
        notifier.notify(_make_request())
        req = opener.call_args.args[0]
        assert req.get_header('X-tenant') == 'rocketride'
