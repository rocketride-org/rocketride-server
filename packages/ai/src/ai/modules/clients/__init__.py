"""
Clients module for serving downloadable client packages.

This module provides HTTP endpoints to download client SDKs (Python, TypeScript, and VSCode)
from the build/Engine/clients directory.
"""

from typing import Any, Dict
from ai.web import WebServer
from .clients import client_python_file, client_typescript, client_vscode


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the clients module by registering routes with the web server.

    This function sets up the client download endpoints for serving Python and
    TypeScript client packages. These endpoints allow users to download the
    client SDKs directly from the server.

    Args:
        server (WebServer): The web server instance where routes will be registered.
                           This should be an instance that supports add_route method.
        config (Dict[str, Any]): Configuration settings for the module. Currently
                                unused but provided for future extensibility.

    Routes registered:
        - GET /client/python/{filename}: Serves Python wheel file (use "latest" for latest version)
        - GET /client/typescript: Serves latest TypeScript tarball
        - GET /client/vscode: Serves latest VSCode extension file

    Note:
        These routes are marked as public since they serve downloadable packages
        that may need to be accessed without authentication.
    """
    # Register the Python client route handler
    server.add_route(
        path='/client/python/{filename}',
        routeHandler=client_python_file,
        methods=['GET'],
        public=True,
    )

    # Register the TypeScript client route handler
    server.add_route(
        path='/client/typescript',
        routeHandler=client_typescript,
        methods=['GET'],
        public=True,
    )

    # Register the VSCode extension route handler
    server.add_route(
        path='/client/vscode',
        routeHandler=client_vscode,
        methods=['GET'],
        public=True,
    )
