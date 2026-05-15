"""Tests for MCP SSE endpoint redirect origin validation.

Verifies that _handle_sse_event rejects absolute-URL redirects that would
send auth headers to a different origin (token theft via urljoin).
"""

import os
import sys

import pytest

# Add the mcp_client source directory to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src', 'nodes', 'tool_mcp_client'))

from mcp_sse_client import McpProtocolError, McpSseClient


def _make_client(sse_endpoint: str) -> McpSseClient:
    """Create a client without starting the SSE connection."""
    return McpSseClient(sse_endpoint=sse_endpoint)


class TestEndpointRedirectValidation:
    """Ensure the endpoint event validates same-origin."""

    # ---- Cases that MUST be accepted (same origin) ----

    def test_relative_url_accepted(self):
        """A normal relative path should be resolved and accepted."""
        client = _make_client('https://legit-server.com/sse')
        client._handle_sse_event(event='endpoint', data='/messages?session=abc123')
        assert client._endpoint_url == 'https://legit-server.com/messages?session=abc123'

    def test_same_origin_absolute_url_accepted(self):
        """An absolute URL on the same origin should be accepted."""
        client = _make_client('https://legit-server.com/sse')
        client._handle_sse_event(
            event='endpoint',
            data='https://legit-server.com/messages?session=abc123',
        )
        assert client._endpoint_url == 'https://legit-server.com/messages?session=abc123'

    def test_https_explicit_443_accepted(self):
        """https://example.com/sse redirecting to https://example.com:443/messages is same origin."""
        client = _make_client('https://example.com/sse')
        client._handle_sse_event(
            event='endpoint',
            data='https://example.com:443/messages',
        )
        assert client._endpoint_url == 'https://example.com:443/messages'

    def test_http_explicit_80_accepted(self):
        """http://example.com/sse redirecting to http://example.com:80/messages is same origin."""
        client = _make_client('http://example.com/sse')
        client._handle_sse_event(
            event='endpoint',
            data='http://example.com:80/messages',
        )
        assert client._endpoint_url == 'http://example.com:80/messages'

    # ---- Cases that MUST be rejected (different origin) ----

    def test_different_host_absolute_url_rejected(self):
        """An absolute URL pointing to a different host must be rejected."""
        client = _make_client('https://legit-server.com/sse')
        with pytest.raises(McpProtocolError, match='redirect rejected'):
            client._handle_sse_event(
                event='endpoint',
                data='https://evil.com/steal',
            )
        assert client._endpoint_url is None

    def test_different_scheme_rejected(self):
        """Downgrading from https to http must be rejected."""
        client = _make_client('https://legit-server.com/sse')
        with pytest.raises(McpProtocolError, match='redirect rejected'):
            client._handle_sse_event(
                event='endpoint',
                data='http://legit-server.com/messages',
            )

    def test_different_port_rejected(self):
        """A different port constitutes a different origin and must be rejected."""
        client = _make_client('https://legit-server.com:443/sse')
        with pytest.raises(McpProtocolError, match='redirect rejected'):
            client._handle_sse_event(
                event='endpoint',
                data='https://legit-server.com:8443/messages',
            )

    def test_subdomain_rejected(self):
        """A different subdomain is a different origin and must be rejected."""
        client = _make_client('https://api.legit-server.com/sse')
        with pytest.raises(McpProtocolError, match='redirect rejected'):
            client._handle_sse_event(
                event='endpoint',
                data='https://evil.legit-server.com/steal',
            )

    # ---- Non-endpoint events ----

    def test_non_endpoint_events_ignored(self):
        """Non-endpoint events should not set _endpoint_url."""
        client = _make_client('https://legit-server.com/sse')
        client._handle_sse_event(event='keepalive', data='ping')
        assert client._endpoint_url is None

    def test_message_event_not_treated_as_endpoint(self):
        """Message events should go through JSON parsing, not endpoint logic."""
        client = _make_client('https://legit-server.com/sse')
        client._handle_sse_event(
            event='message',
            data='{"jsonrpc":"2.0","id":1,"result":{}}',
        )
        assert client._endpoint_url is None
