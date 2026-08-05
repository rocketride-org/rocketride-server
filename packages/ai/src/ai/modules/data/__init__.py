from typing import Dict, Any
from ai.web import WebServer
from .data_server import DataServer


def initModule(server: WebServer, config: Dict[str, Any]):
    """Register the /task/data WebSocket endpoint backed by a DataServer.

    The DataServer reads its target endpoint lazily from ``server.app.state.target``
    at WebSocket-connection time, so this module is safe to load before any
    source node has registered a target. Source nodes (webhook, telegram) set
    ``state.target`` in their ``_run()`` method, which may execute after this
    module has already been loaded (e.g. when ``node.py`` eager-loads ``data``
    in the shared subprocess web server).
    """
    # Create the DataServer instance with a reference to the server so it can
    # read state.target lazily. Do NOT capture state.target here — it may not
    # be set yet for sourceless pipelines (agentic, etc.).
    data_server = DataServer(server=server, config=config)

    # Register our routes
    server.add_socket('/task/data', data_server.listen)
