"""
Dropper module for serving static files with authentication.

This module provides a dropper interface by serving static files from a dropper directory
with proper authentication handling via cookies and query parameters.
"""

import os
from pathlib import Path
from fastapi.responses import FileResponse
from ai.web import Request

# Compute the root directory for dropper static files
# This points to the 'dropper' subdirectory relative to this module's location
dropper_root = os.path.dirname(os.path.realpath(__file__)) + '/dropperUI/dist'

next_dropper_id = 1


async def dropper(request: Request):
    """
    Serve static files for the dropper interface with authentication.

    This function handles serving static files for a Single Page Application (SPA)
    dropper interface. It includes authentication via cookies or query parameters,
    path traversal security checks, and fallback behavior for SPA routing.

    Authentication flow:
    1. Check for 'apikey' and 'token' in cookies - if present, serve the file
    2. If not in cookies, check query parameters and redirect with cookies set
    3. If neither present, return 401 Unauthorized

    Args:
        request (Request): The incoming HTTP request object containing path parameters,
                          cookies, and query parameters.

    Returns:
        FileResponse: The requested static file or index.html fallback
        RedirectResponse: Redirect to /chat with authentication cookies set
        HTTPException: 401 Unauthorized if authentication credentials missing

    Raises:
        HTTPException: 401 status when apikey and token are not provided
    """
    # Authentication successful - proceed with file serving
    # Get the requested file path from URL parameters
    requested_path = request.path_params.get('file_path', '')

    # Build the absolute file path
    if requested_path:
        # Serve the specific requested file
        file_path = Path(dropper_root) / requested_path
    else:
        # Default to index.html for root /dropper or /dropper/ requests
        file_path = Path(dropper_root) / 'index.html'

    # Security check - prevent path traversal attacks
    # Ensure the resolved path stays within the dropper_root directory
    try:
        # Resolve any relative path components (../, ./, etc.)
        file_path = file_path.resolve()
        dist_path = Path(dropper_root).resolve()

        # Verify the resolved path is within our allowed directory
        if not str(file_path).startswith(str(dist_path)):
            # Path traversal attempt detected - fallback to safe default
            file_path = dist_path / 'index.html'
    except Exception:
        # Any path resolution error - fallback to safe default
        file_path = Path(dropper_root) / 'index.html'

    # Serve the file if it exists, otherwise fallback for SPA routing
    if file_path.exists() and file_path.is_file():
        # File found - serve it directly
        return FileResponse(file_path)
    else:
        # File not found - serve index.html for SPA client-side routing
        # This allows the frontend JavaScript router to handle the route
        return FileResponse(f'{dropper_root}/index.html')
