"""
EaasServer: WebSocket Proxy for DAP-Based Mid-Tier Services.

This module implements the middle layer in a three-tier distributed pipeline.
It serves as a proxy that forwards Debug Adapter Protocol (DAP) traffic over WebSockets
between clients (such as ALB servers) and backend engines.

Primary Responsibilities:
-------------------------
1. Acts as the mid-tier of the pipeline stack, bridging the frontend ALB layer with backend engine nodes.
2. Accepts incoming WebSocket connections on `/task/service`.
3. On receiving a 'launch' command, it initiates a new backend engine with the appropriate pipeline configuration.
4. On receiving an 'attach' command, it attaches the client to an existing backend engine session.
5. On 'disconnect', it terminates the session and tears down associated WebSocket connections.
6. For all other DAP commands, it transparently proxies requests and responses.

Modules:
--------
- services: Service discovery and registration
- pipe: Pipeline management
- chat: Chat/conversation handling
- dropper: File drop handling
- clients: Client connection management
- task: Task execution and management
- task_http: HTTP task endpoints
- profiler: Performance profiling

Usage:
    engine ai/eaas.py [options]
"""

# Remove auto-added script directory to avoid import conflicts with the ai package
import sys as _sys
if _sys.path and (_sys.path[0].endswith('ai') or _sys.path[0].endswith('ai\\') or _sys.path[0].endswith('ai/')):
    _sys.path.pop(0)

import argparse
import asyncio
from typing import Any, Dict

from ai.web import WebServer


def create_parser() -> argparse.ArgumentParser:
    """Create argument parser for EAAS server."""
    parser = argparse.ArgumentParser(
        prog='eaas-server',
        description='EAAS WebSocket Proxy Server',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Start with defaults (port 5565)
  engine ai/eaas.py

  # With model server on default port
  engine ai/eaas.py --modelserver=5590

  # With model server on remote host
  engine ai/eaas.py --modelserver=192.168.1.100:5590

  # Custom port and model server
  engine ai/eaas.py --port=5566 --modelserver=5590

  # Verbose logging
  engine ai/eaas.py --verbose
""",
    )

    # Server configuration
    parser.add_argument(
        '--host',
        default='0.0.0.0',
        help='Server host/interface to bind (default: 0.0.0.0)',
    )
    parser.add_argument(
        '--port',
        type=int,
        default=5565,
        help='Server port (default: 5565)',
    )

    # Model server
    parser.add_argument(
        '--modelserver',
        metavar='ADDRESS',
        default=None,
        help='Model server address (PORT or HOST:PORT). Passed to tasks for AI model inference.',
    )

    # Task port allocation
    parser.add_argument(
        '--base_port',
        type=int,
        default=20000,
        help='Base port for task data/debug allocation (default: 20000, range: base to base+9999)',
    )

    # Logging
    parser.add_argument(
        '--verbose', '-v',
        action='store_true',
        help='Enable verbose/debug logging',
    )

    return parser


async def run(config: Dict[str, Any] = None) -> None:
    """
    Entrypoint to run the EAAS WebSocket proxy server.

    Loads port and host from command-line arguments (or uses defaults),
    configures the server, and starts listening for connections.

    Args:
        config: Configuration dict (from argparse or programmatic use)
    """
    if config is None:
        config = {}

    # Parse command line if not provided programmatically
    if 'port' not in config:
        parser = create_parser()
        args = parser.parse_args()

        config['host'] = args.host
        config['port'] = args.port
        config['modelserver'] = args.modelserver
        config['base_port'] = args.base_port
        config['verbose'] = args.verbose

    print('[EAAS_SERVER] Configuration:')
    print(f'  Host: {config["host"]}')
    print(f'  Port: {config["port"]}')
    if config.get('modelserver'):
        print(f'  Model Server: {config["modelserver"]}')
    if config.get('verbose'):
        print('  Verbose logging: enabled')

    # Create the server
    server = WebServer(config=config, standardEndpoints=False)

    # Add our modules
    server.use('services')
    server.use('pipe')
    server.use('chat')
    server.use('dropper')
    server.use('clients')
    server.use('task')
    server.use('task_http')
    server.use('profiler')

    # Start the FastAPI server loop
    await server.serve()


def main():
    """Main entry point."""
    try:
        asyncio.run(run())
    except (KeyboardInterrupt, SystemExit):
        pass


if __name__ == '__main__':
    main()
