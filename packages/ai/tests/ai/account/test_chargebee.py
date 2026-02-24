"""
Unit tests for ChargebeeClient usage reporting.

Tests cover:
- Initialization (enabled / disabled)
- Usage reporting (success, retries, auth errors, edge cases)
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from ai.account.chargebee import ChargebeeClient


# ============================================================================
# Initialization Tests
# ============================================================================


class TestChargebeeClientInit:
    """Test ChargebeeClient initialization and enablement logic."""

    def test_init_enabled(self):
        """Client is enabled when both site and api_key are provided."""
        client = ChargebeeClient(site='test-site', api_key='test-key')
        assert client.enabled is True

    def test_init_disabled_no_site(self):
        """Client is disabled when site is missing."""
        client = ChargebeeClient(site='', api_key='test-key')
        assert client.enabled is False

    def test_init_disabled_no_key(self):
        """Client is disabled when api_key is missing."""
        client = ChargebeeClient(site='test-site', api_key='')
        assert client.enabled is False


# ============================================================================
# Usage Reporting Tests
# ============================================================================


class TestChargebeeReportUsage:
    """Test ChargebeeClient.report_usage behavior."""

    @pytest.mark.asyncio
    async def test_report_usage_disabled_is_noop(self):
        """report_usage does nothing when client is disabled."""
        client = ChargebeeClient(site='', api_key='')
        assert client.enabled is False

        # Should not raise, just silently return
        await client.report_usage('sub_123', 100)

    @pytest.mark.asyncio
    @patch('ai.account.chargebee.httpx.AsyncClient')
    async def test_report_usage_success(self, mock_client_cls):
        """Successful usage report sends correct URL and data."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        client = ChargebeeClient(site='test-site', api_key='test-key')
        await client.report_usage('sub_123', 500, usage_date='2026-02-23')

        mock_client.post.assert_called_once()
        call_args = mock_client.post.call_args

        # Verify URL contains subscription ID
        url = call_args[0][0] if call_args[0] else call_args[1].get('url', '')
        assert 'sub_123' in url
        assert 'test-site.chargebee.com' in url

        # Verify data contains quantity
        data = call_args[1].get('data', {})
        assert data['quantity'] == '500'

    @pytest.mark.asyncio
    @patch('ai.account.chargebee.asyncio.sleep', new_callable=AsyncMock)
    @patch('ai.account.chargebee.httpx.AsyncClient')
    async def test_report_usage_retries_on_5xx(self, mock_client_cls, mock_sleep):
        """Client retries once on 5xx server error, then succeeds."""
        # First call: 503 Service Unavailable
        mock_response_503 = MagicMock()
        mock_response_503.status_code = 503
        mock_response_503.raise_for_status = MagicMock(
            side_effect=Exception('503 Service Unavailable')
        )

        # Second call: 200 OK
        mock_response_200 = MagicMock()
        mock_response_200.status_code = 200
        mock_response_200.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(
            side_effect=[mock_response_503, mock_response_200]
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        client = ChargebeeClient(site='test-site', api_key='test-key')
        await client.report_usage('sub_123', 100)

        assert mock_client.post.call_count == 2
        assert client.enabled is True

    @pytest.mark.asyncio
    @patch('ai.account.chargebee.asyncio.sleep', new_callable=AsyncMock)
    @patch('ai.account.chargebee.httpx.AsyncClient')
    async def test_report_usage_gives_up_after_retries(self, mock_client_cls, mock_sleep):
        """Client gives up after exhausting retries on persistent 5xx errors."""
        mock_response_503 = MagicMock()
        mock_response_503.status_code = 503
        mock_response_503.raise_for_status = MagicMock(
            side_effect=Exception('503 Service Unavailable')
        )

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response_503)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        client = ChargebeeClient(site='test-site', api_key='test-key')
        await client.report_usage('sub_123', 100)

        # 1 initial attempt + 1 retry = 2 total calls
        assert mock_client.post.call_count == 2
        # Client should still be enabled (5xx is transient, not auth failure)
        assert client.enabled is True

    @pytest.mark.asyncio
    @patch('ai.account.chargebee.httpx.AsyncClient')
    async def test_report_usage_disables_on_auth_error(self, mock_client_cls):
        """Client disables itself on 401 authentication error."""
        mock_response_401 = MagicMock()
        mock_response_401.status_code = 401

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response_401)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client_cls.return_value = mock_client

        client = ChargebeeClient(site='test-site', api_key='test-key')
        assert client.enabled is True

        await client.report_usage('sub_123', 100)

        assert client.enabled is False

    @pytest.mark.asyncio
    async def test_report_usage_skips_no_subscription_id(self):
        """report_usage is a noop when subscription_id is empty."""
        client = ChargebeeClient(site='test-site', api_key='test-key')
        assert client.enabled is True

        # Should not raise, just silently return
        await client.report_usage('', 100)
