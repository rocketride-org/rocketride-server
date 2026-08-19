"""
Clients module for serving downloadable client packages.

This module provides handlers for serving Python and TypeScript client packages
from the build directory. The packages are served as downloadable files with
appropriate content types and filenames.
"""

import os
import sys
from pathlib import Path
from fastapi.responses import FileResponse, JSONResponse
from ai.web import Request


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


def _get_static_clients_root() -> Path:
    """
    Get the static clients directory served with the engine binary.

    Build tasks land installable client packages in static/clients/ next to
    the engine executable (dist/server/static/clients/), so the path is
    resolved from the binary's location — like the shell module's static
    roots — rather than the working directory.

    Returns:
        Path: The resolved path to the static clients directory
    """
    # Engine binary directory + static/clients (e.g. dist/server/static/clients)
    return Path(os.path.dirname(sys.executable)) / 'static' / 'clients'


async def client_shell(request: Request):
    """
    Serve the installable shell platform package (shell.tgz).

    The shell build packs the compiled shell library, the frozen contract
    types, and the token CSS into a stable-named shell.tgz under
    static/clients/shell/. Standalone app repos vendor the platform from
    here (builder shell:update), so the package always tracks the server
    the client is connected to.

    Args:
        request (Request): The incoming HTTP request object

    Returns:
        FileResponse: The shell platform package file
        JSONResponse: Error message if file not found (404)

    Example:
        GET /client/shell
        -> Downloads: shell.tgz
    """
    # Stable name: the version rides inside the package, not the filename
    tgz_file = _get_static_clients_root() / 'shell' / 'shell.tgz'

    if not tgz_file.exists():
        return JSONResponse(
            status_code=404,
            content={
                'error': 'Shell package not found',
                'message': 'shell.tgz could not be found in the static clients directory.',
            },
        )

    # Serve the tgz file with appropriate headers
    return FileResponse(tgz_file, media_type='application/gzip', filename=tgz_file.name)


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
        GET /client/python/rocketride-1.3.0-py3-none-any.whl
        -> Serves: rocketride-1.3.0-py3-none-any.whl

        GET /client/python/latest
        -> Serves: rocketride-1.3.0-py3-none-any.whl (newest wheel)
    """
    clients_root = _get_static_clients_root() / 'python'

    # Check if "latest" version is requested
    if 'latest' in filename.lower():
        # Find the latest wheel file
        wheel_file = _find_latest_file(clients_root, 'rocketride*.whl')
        if not wheel_file or not wheel_file.exists():
            return JSONResponse(
                status_code=404,
                content={
                    'error': 'Python client package not found',
                    'message': 'No Python client packages found in the build directory.',
                },
            )
    else:
        # The filename rides in straight off the URL — refuse separators and
        # parent segments before joining (a backslash traverses on Windows).
        if '/' in filename or '\\' in filename or '..' in filename:
            return JSONResponse(
                status_code=404,
                content={
                    'error': 'Python client package not found',
                    'message': f'The file {filename} could not be found.',
                },
            )
        # Serve specific version
        wheel_file = clients_root / filename
        if not wheel_file.exists():
            return JSONResponse(
                status_code=404,
                content={
                    'error': 'Python client package not found',
                    'message': f'The file {filename} could not be found.',
                },
            )

    # Serve the wheel file with appropriate headers
    # Use application/zip since wheel files are zip archives
    return FileResponse(wheel_file, media_type='application/zip', filename=wheel_file.name)


async def client_typescript(request: Request):
    """
    Serve the latest TypeScript client package.

    This endpoint serves the latest TypeScript client package (.tgz) from the
    static clients directory beside the engine binary. The file is served with
    appropriate headers for browser download.

    Args:
        request (Request): The incoming HTTP request object

    Returns:
        FileResponse: The TypeScript client package file
        JSONResponse: Error message if file not found (404)

    Example:
        GET /client/typescript
        -> Downloads: rocketride-1.3.0.tgz
    """
    clients_root = _get_static_clients_root() / 'typescript'

    # Look for the latest TypeScript package file
    tgz_file = _find_latest_file(clients_root, 'rocketride*.tgz')

    if not tgz_file or not tgz_file.exists():
        return JSONResponse(
            status_code=404,
            content={
                'error': 'TypeScript client package not found',
                'message': 'The TypeScript client package could not be found in the build directory.',
            },
        )

    # Serve the tgz file with appropriate headers
    return FileResponse(tgz_file, media_type='application/gzip', filename=tgz_file.name)


async def client_vscode(request: Request):
    """
    Serve the latest VSCode extension package.

    This endpoint serves the latest VSCode extension package (.vsix) from the
    static clients directory beside the engine binary. The file is served with
    appropriate headers for browser download.

    Args:
        request (Request): The incoming HTTP request object

    Returns:
        FileResponse: The VSCode extension package file
        JSONResponse: Error message if file not found (404)

    Example:
        GET /client/vscode
        -> Downloads: rocketride-1.0.0.vsix
    """
    clients_root = _get_static_clients_root() / 'vscode'

    # Look for the latest VSCode extension file
    vsix_file = _find_latest_file(clients_root, 'rocketride*.vsix')

    if not vsix_file or not vsix_file.exists():
        return JSONResponse(
            status_code=404,
            content={
                'error': 'VSCode extension package not found',
                'message': 'The VSCode extension package could not be found in the build directory.',
            },
        )

    # Serve the vsix file with appropriate headers
    return FileResponse(vsix_file, media_type='application/octet-stream', filename=vsix_file.name)
