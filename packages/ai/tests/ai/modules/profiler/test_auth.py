"""
Tests for profiler module security fixes.

Verifies that:
1. All profiler endpoints are registered WITHOUT public=True (require auth)
2. The /profile/report endpoint handler HTML-escapes output to prevent XSS
3. Route methods match documentation (POST not PUT for start/stop)
"""

import asyncio
import sys
from unittest.mock import MagicMock

# Stub runtime-only modules so the profiler can be imported in a test context
# without the full server stack. These are scoped to this file only.
for _mod_name in ('depends', 'rocketride', 'rocketride.core'):
    if _mod_name not in sys.modules:
        sys.modules[_mod_name] = MagicMock()

from ai.modules.profiler.profile import WebServerProfiler
from ai.modules.profiler import _setup_profiling_endpoints


def _get_registered_routes():
    """Set up a mock server, run endpoint registration, return add_route calls."""
    mock_server = MagicMock()
    mock_server.app.state = MagicMock()
    profiler = WebServerProfiler()
    _setup_profiling_endpoints(mock_server, profiler)
    return mock_server.add_route.call_args_list


def _get_report_handler_and_profiler():
    """Set up a mock server, return the /profile/report endpoint handler and profiler.

    Extracts the actual async handler registered via add_route so tests can
    invoke it directly and verify the HTMLResponse it returns.
    """
    mock_server = MagicMock()
    mock_server.app.state = MagicMock()
    profiler = WebServerProfiler()
    _setup_profiling_endpoints(mock_server, profiler)
    calls = mock_server.add_route.call_args_list
    report_calls = [c for c in calls if c[0][0] == '/profile/report']
    assert len(report_calls) == 1, "Expected exactly one /profile/report route"
    handler = report_calls[0][0][1]
    return handler, profiler


class TestProfilerRoutesRequireAuth:
    """Verify that profiler routes are not registered as public."""

    def test_profile_dashboard_not_public(self):
        """GET /profile must require authentication."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile']
        assert len(matches) == 1
        _, kwargs = matches[0]
        assert 'public' not in kwargs or kwargs['public'] is False

    def test_profile_start_not_public(self):
        """POST /profile/start must require authentication."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile/start']
        assert len(matches) == 1
        _, kwargs = matches[0]
        assert 'public' not in kwargs or kwargs['public'] is False

    def test_profile_stop_not_public(self):
        """POST /profile/stop must require authentication."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile/stop']
        assert len(matches) == 1
        _, kwargs = matches[0]
        assert 'public' not in kwargs or kwargs['public'] is False

    def test_profile_status_not_public(self):
        """GET /profile/status must require authentication."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile/status']
        assert len(matches) == 1
        _, kwargs = matches[0]
        assert 'public' not in kwargs or kwargs['public'] is False

    def test_profile_report_not_public(self):
        """GET /profile/report must require authentication."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile/report']
        assert len(matches) == 1
        _, kwargs = matches[0]
        assert 'public' not in kwargs or kwargs['public'] is False

    def test_no_routes_are_public(self):
        """No profiler route should be registered with public=True."""
        calls = _get_registered_routes()
        for c in calls:
            _, kwargs = c
            assert kwargs.get('public', False) is False, (
                f"Route {c[0][0]} is registered as public but should require auth"
            )


class TestProfilerReportXSSEscape:
    """Verify that the /profile/report endpoint handler HTML-escapes output."""

    def test_endpoint_escapes_script_tags(self):
        """The /profile/report handler must escape <script> tags in its HTML output."""
        handler, profiler = _get_report_handler_and_profiler()
        profiler.current_profile_data = '<script>alert("xss")</script>'

        mock_request = MagicMock()
        response = asyncio.run(handler(mock_request))

        body = response.body.decode()
        assert '<script>' not in body
        assert '&lt;script&gt;' in body

    def test_endpoint_escapes_angle_brackets(self):
        """The /profile/report handler must escape angle brackets in its HTML output."""
        handler, profiler = _get_report_handler_and_profiler()
        profiler.current_profile_data = 'File <module> at line 42'

        mock_request = MagicMock()
        response = asyncio.run(handler(mock_request))

        body = response.body.decode()
        assert '<module>' not in body
        assert '&lt;module&gt;' in body

    def test_endpoint_wraps_report_in_pre_tag(self):
        """The /profile/report handler must wrap escaped output in <pre> tags."""
        handler, profiler = _get_report_handler_and_profiler()
        profiler.current_profile_data = 'normal profiling output'

        mock_request = MagicMock()
        response = asyncio.run(handler(mock_request))

        body = response.body.decode()
        assert body.startswith('<pre>')
        assert body.endswith('</pre>')
        assert 'normal profiling output' in body

    def test_endpoint_returns_html_response(self):
        """The /profile/report handler must return an HTMLResponse with text/html media type."""
        handler, profiler = _get_report_handler_and_profiler()
        profiler.current_profile_data = 'some data'

        mock_request = MagicMock()
        response = asyncio.run(handler(mock_request))

        from fastapi.responses import HTMLResponse
        assert isinstance(response, HTMLResponse)
        assert response.media_type == 'text/html'

    def test_endpoint_escapes_ampersands_and_quotes(self):
        """The /profile/report handler must escape ampersands and quotes."""
        handler, profiler = _get_report_handler_and_profiler()
        profiler.current_profile_data = 'a&b "c" <d>'

        mock_request = MagicMock()
        response = asyncio.run(handler(mock_request))

        body = response.body.decode()
        assert 'a&amp;b' in body
        assert '&lt;d&gt;' in body
        # Raw dangerous chars must not appear unescaped
        assert '<d>' not in body


class TestProfilerRouteMethodsMatchDocs:
    """Verify that registered route HTTP methods match the module docstring."""

    def test_start_route_uses_post(self):
        """/profile/start must be registered as POST (not PUT)."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile/start']
        assert len(matches) == 1
        methods = matches[0][0][2]
        assert 'POST' in methods

    def test_stop_route_uses_post(self):
        """/profile/stop must be registered as POST (not PUT)."""
        calls = _get_registered_routes()
        matches = [c for c in calls if c[0][0] == '/profile/stop']
        assert len(matches) == 1
        methods = matches[0][0][2]
        assert 'POST' in methods
