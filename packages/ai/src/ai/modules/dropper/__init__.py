"""
Dropper module for serving static files with authentication.

This module provides a dropper interface by serving static files from a dropper directory
with proper authentication handling via cookies and query parameters.
"""

from typing import Any, Dict
from ai.web import WebServer
from .dropper import dropper


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the dropper module by registering routes with the web server.

    This function sets up the dropper interface by registering the necessary HTTP routes
    for serving static files. The dropper interface supports Single Page Application
    behavior with client-side routing.

    Args:
        server (WebServer): The web server instance where routes will be registered.
                           This should be an instance that supports addRoute method.
        config (Dict[str, Any]): Configuration settings for the module. Currently
                                unused but provided for future extensibility.

    Routes registered:
        - GET /dropper/{file_path:path}: Serves static files from the dropper directory
                                     with authentication and SPA fallback behavior.
                                     The {file_path:path} parameter captures the
                                     entire remaining path for flexible file serving.

    Note:
        The route uses a path parameter that captures the entire remaining URL path,
        allowing for nested directory structures within the dropper static files.
    """
    # Register the dropper route handler
    server.add_route(
        path='/dropper',  # Captures just dropper
        routeHandler=dropper,  # Function to handle requests
        methods=['GET'],  # Only GET requests supported
        public=True,
    )

    # Register the dropper/* route handler
    server.add_route(
        path='/dropper/{file_path:path}',  # Captures entire remaining path
        routeHandler=dropper,  # Function to handle requests
        methods=['GET'],  # Only GET requests supported
        public=True,
    )
