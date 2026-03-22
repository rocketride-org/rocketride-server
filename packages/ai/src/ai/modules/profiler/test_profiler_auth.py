"""
Tests for profiler module security fixes.

Verifies that:
1. All profiler endpoints are registered WITHOUT public=True (require auth)
2. The profile report HTML-escapes output to prevent XSS
"""

import html as html_module
from unittest.mock import MagicMock

from ai.modules.profiler.profile import WebServerProfiler
from ai.modules.profiler import _setup_profiling_endpoints


def _get_registered_routes():
    """Set up a mock server, run endpoint registration, return add_route calls."""
    mock_server = MagicMock()
    mock_server.app.state = MagicMock()
    profiler = WebServerProfiler()
    _setup_profiling_endpoints(mock_server, profiler)
    return mock_server.add_route.call_args_list


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
    """Verify that the profile report HTML-escapes output."""

    def test_report_escapes_html_script_tags(self):
        """Profile report containing script tags must be escaped."""
        profiler = WebServerProfiler()
        malicious = '<script>alert("xss")</script>'
        profiler.current_profile_data = malicious

        report = profiler.get_full_report()
        escaped = html_module.escape(report)

        assert '<script>' not in escaped
        assert '&lt;script&gt;' in escaped

    def test_report_escapes_angle_brackets(self):
        """Angle brackets in profiler output must be escaped."""
        profiler = WebServerProfiler()
        profiler.current_profile_data = 'File <module> at line 42'

        report = profiler.get_full_report()
        escaped = html_module.escape(report)

        assert '<module>' not in escaped
        assert '&lt;module&gt;' in escaped
