from typing import Optional

from ai.web import WebServer
from ai.common.schema import Autopipe

from .remote_create import remote_create
from .remote_delete import remote_delete
from .remote_pipe import remote_pipe


def initModule(server: WebServer, _config: Optional[Autopipe] = None):
    """
    Initialize the module by registering API routes for search and configuration.

    Route GET, POST `/api/v0`: Calls `api_v0` for handling API requests.

    Args:
        server (WebServer): The web server instance where routes will be registered.
        config (Dict[str, Any]): Configuration settings for the module.
    """
    # Add the route
    server.add_route('/remote', remote_create, methods=['POST'])
    server.add_route('/remote', remote_delete, methods=['DELETE'])
    server.app.router.add_api_websocket_route('/remote/pipe', remote_pipe)
