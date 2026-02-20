from typing import Dict, Any
from ai.web import WebServer
from .data_server import DataServer


def initModule(server: WebServer, config: Dict[str, Any]):
    """
    Initialize the module by registering API routes related to pipe management.
    """
    # Get the target endpoint
    target = server.app.state.target

    # Create the DataServer instance
    data_server = DataServer(server=server, target=target, config=config)

    # Register our routes
    server.add_socket('/task/data', data_server.listen)
