"""
Profiler Module for RocketRide Web Services.

This module provides integrated profiling capabilities for web servers.
It can be loaded dynamically using server.use('profiler').

Usage:
    server.use('profiler')

    # Then access via:
    # POST /profile/start?session=test
    # POST /profile/stop
    # GET /profile
    # GET /profile/status
    # GET /profile/report
"""

from typing import Dict, Any
from ai.web import WebServer
from fastapi import Request, Query
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel
from .profile import WebServerProfiler


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the profiler module by registering profiling API routes.

    Args:
        server (WebServer): The web server instance to add routes to
        config (Dict[str, Any]): Configuration parameters for the profiler
    """
    # Create the profiler instance
    profiler = WebServerProfiler()

    # Store profiler in server state for access by other modules if needed
    server.app.state.profiler = profiler

    # Setup profiling endpoints
    _setup_profiling_endpoints(server, profiler)


def _setup_profiling_endpoints(server: WebServer, profiler: WebServerProfiler):
    """Define the setup for profiling control endpoints on the server."""

    # Response models for OpenAPI documentation
    class ProfileControlResponse(BaseModel):
        message: str
        status: str
        session: str = None
        start_time: float = None
        runtime: float = None
        top_functions: list = None
        profile_record: dict = None

    class ProfileStatusResponse(BaseModel):
        status: str
        message: str
        session: str = None
        start_time: float = None
        runtime: float = None
        history_count: int = None
        last_profiles: list = None

    async def start_profiling(request: Request, session: str = Query(None, description='Optional session name for the profiling session')) -> ProfileControlResponse:
        """
        Start a new profiling session.

        This endpoint begins collecting performance data for all subsequent
        operations until profiling is stopped. Each session can be given
        a custom name for identification.

        - **session**: Optional custom name for this profiling session

        Returns detailed information about the started session.
        """
        result = profiler.start_profiling(session)
        if result.get('status') == 'error':
            return JSONResponse(content=result, status_code=400)
        return JSONResponse(content=result)

    async def stop_profiling(request: Request) -> ProfileControlResponse:
        """
        Stop the current profiling session and generate analysis report.

        This endpoint stops data collection and immediately generates a
        comprehensive performance analysis report. The report includes:

        - Function call statistics
        - Time spent in each function
        - Call counts and relationships
        - Performance bottleneck identification

        Returns the complete profiling results and session summary.
        """
        result = profiler.stop_profiling()
        if result.get('status') == 'error':
            return JSONResponse(content=result, status_code=400)
        return JSONResponse(content=result)

    async def get_profile_dashboard(request: Request):
        """
        Display the interactive profiling dashboard.

        Returns an HTML page with:

        - Current profiling status
        - Start/stop controls
        - Session history
        - Quick access to reports
        - Real-time status updates

        This is the main interface for managing profiling sessions.
        """
        html_content = profiler.generate_html_dashboard()
        return HTMLResponse(content=html_content)

    async def get_profile_status(request: Request) -> ProfileStatusResponse:
        """
        Get current profiling status as JSON.

        Returns detailed status information including:

        - Whether profiling is currently active
        - Current session information
        - Runtime statistics
        - Recent session history

        Useful for programmatic monitoring of profiling state.
        """
        return JSONResponse(content=profiler.get_status())

    async def get_profile_report(request: Request):
        """
        Get the complete profiling report from the last completed session.

        Returns a comprehensive text report containing:

        - Session metadata (name, duration, timestamps)
        - Complete function analysis sorted by cumulative time
        - Top functions by execution time
        - Detailed call statistics
        - Performance bottleneck identification

        The report is formatted for easy reading and analysis.
        """
        report = profiler.get_full_report()
        return HTMLResponse(content=f'<pre>{report}</pre>', media_type='text/html')

    # Register the endpoints — require authentication to prevent unauthorized
    # access to profiling controls and performance data (internal function names,
    # call counts, timing information).
    server.add_route('/profile', get_profile_dashboard, ['GET'], public=True)
    server.add_route('/profile/start', start_profiling, ['POST'], public=True)
    server.add_route('/profile/stop', stop_profiling, ['POST'], public=True)
    server.add_route('/profile/status', get_profile_status, ['GET'], public=True)
    server.add_route('/profile/report', get_profile_report, ['GET'], public=True)


def get_status() -> Dict[str, Any]:
    """
    Define optional status callback function that can be registered with the server.

    Returns:
        Dict[str, Any]: Status information for the profiler module
    """
    # This would be called if server.registerStatusCallback(get_status) is used
    return {
        'module': 'profiler',
        'status': 'loaded',
        'endpoints': [
            '/profile/start (POST)',
            '/profile/stop (POST)',
            '/profile (GET)',
            '/profile/status (GET)',
            '/profile/report (GET)',
        ],
    }
