"""
Clients module for serving downloadable client packages.

This module provides handlers for serving Python and TypeScript client packages
from the build directory. The packages are served as downloadable files with
appropriate content types and filenames.
"""

from pathlib import Path
from fastapi.responses import FileResponse, JSONResponse
from ai.web import Request


def _get_clients_root() -> Path:
    """
    Get the root directory for client packages.

    Returns the path to the clients directory relative to the current working directory.
    The engine runs from build/Engine, so clients are in ./clients

    Returns:
        Path: The resolved path to the clients directory
    """
    # Engine runs from build/Engine, so clients are at ./clients
    clients_dir = Path('./clients')

    return clients_dir


def _find_latest_file(directory: Path, pattern: str) -> Path | None:
    """
    Find the latest file matching the given pattern in the directory.

    Args:
        directory: Directory to search in
        pattern: Glob pattern to match files (e.g., "*.whl")

    Returns:
        Path to the latest file, or None if no files found
    """
    files = list(directory.glob(pattern))
    if not files:
        return None

    # Sort by modification time, newest first
    files.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return files[0]


async def client_python_file(request: Request, filename: str):
    """
    Serve a specific Python client wheel file, or latest if "latest" version is specified.

    This endpoint serves wheel files by exact filename, or finds the latest if the
    filename contains "latest" as the version.

    Args:
        request (Request): The incoming HTTP request object
        filename (str): The wheel filename to serve (can include "latest" as version)

    Returns:
        FileResponse: The Python client package file
        JSONResponse: Error message if file not found (404)

    Examples:
        GET /client/python/rocketlib_client_python-1.1.0-py3-none-any.whl
        -> Serves: rocketlib_client_python-1.1.0-py3-none-any.whl

        GET /client/python/rocketlib_client_python-latest-py3-none-any.whl
        -> Serves: rocketlib_client_python-1.1.0-py3-none-any.whl (latest version)
    """
    clients_root = _get_clients_root() / 'python' / 'dist'

    # Check if "latest" version is requested
    if 'latest' in filename.lower():
        # Find the latest wheel file
        wheel_file = _find_latest_file(clients_root, 'rocketlib_client_python*.whl')
        if not wheel_file or not wheel_file.exists():
            return JSONResponse(status_code=404, content={'error': 'Python client package not found', 'message': 'No Python client packages found in the build directory.'})
    else:
        # Serve specific version
        wheel_file = clients_root / filename
        if not wheel_file.exists():
            return JSONResponse(status_code=404, content={'error': 'Python client package not found', 'message': f'The file {filename} could not be found.'})

    # Serve the wheel file with appropriate headers
    # Use application/zip since wheel files are zip archives
    return FileResponse(wheel_file, media_type='application/zip', filename=wheel_file.name)


async def client_typescript(request: Request):
    """
    Serve the latest TypeScript client package.

    This endpoint serves the latest TypeScript client package (.tgz) from the
    build/Engine/clients directory. The file is served with appropriate headers
    for browser download.

    Args:
        request (Request): The incoming HTTP request object

    Returns:
        FileResponse: The TypeScript client package file
        JSONResponse: Error message if file not found (404)

    Example:
        GET /client/typescript
        -> Downloads: rocketlib-client-typescript-1.0.0.tgz
    """
    clients_root = _get_clients_root() / 'typescript' / 'dist'

    # Look for the latest TypeScript package file
    tgz_file = _find_latest_file(clients_root, 'rocketlib-client-typescript*.tgz')

    if not tgz_file or not tgz_file.exists():
        return JSONResponse(status_code=404, content={'error': 'TypeScript client package not found', 'message': 'The TypeScript client package could not be found in the build directory.'})

    # Serve the tgz file with appropriate headers
    return FileResponse(tgz_file, media_type='application/gzip', filename=tgz_file.name)


async def client_vscode(request: Request):
    """
    Serve the latest VSCode extension package.

    This endpoint serves the latest VSCode extension package (.vsix) from the
    build/Engine/clients directory. The file is served with appropriate headers
    for browser download.

    Args:
        request (Request): The incoming HTTP request object

    Returns:
        FileResponse: The VSCode extension package file
        JSONResponse: Error message if file not found (404)

    Example:
        GET /client/vscode
        -> Downloads: rocketlib-1.0.0.vsix
    """
    clients_root = _get_clients_root()

    # Look for the latest VSCode extension file
    vsix_file = _find_latest_file(clients_root, 'rocketlib-*.vsix')

    if not vsix_file or not vsix_file.exists():
        return JSONResponse(status_code=404, content={'error': 'VSCode extension package not found', 'message': 'The VSCode extension package could not be found in the build directory.'})

    # Serve the vsix file with appropriate headers
    return FileResponse(vsix_file, media_type='application/octet-stream', filename=vsix_file.name)
