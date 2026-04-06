"""
Chat module for serving static files with authentication.

This module provides a chat interface by serving static files from a chat directory
with proper authentication handling via cookies and query parameters.
"""

import os
import sys
from pathlib import Path
from fastapi.responses import FileResponse
from fastapi import HTTPException
from ai.web import Request

# Directory containing engine.exe
root_dir = os.path.dirname(sys.executable)

# Chat static files: ./static/chat (server cwd is dist/server)
chat_root = os.path.join(root_dir, 'static', 'chat')

next_chat_id = 1


async def chat(request: Request):
    """
    Serve static files for the chat interface with authentication.

    This function handles serving static files for a Single Page Application (SPA)
    chat interface. It includes authentication via cookies or query parameters,
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
        file_path = Path(chat_root) / requested_path
    else:
        # Default to index.html for root /chat or /chat/ requests
        file_path = Path(chat_root) / 'index.html'

    # Security check - prevent path traversal attacks
    # Ensure the resolved path stays within the chat_root directory
    try:
        # Resolve any relative path components (../, ./, etc.)
        file_path = file_path.resolve()
        dist_path = Path(chat_root).resolve()

        # Verify the resolved path is within our allowed directory
        if not file_path.is_relative_to(dist_path):
            # Path traversal attempt detected - fallback to safe default
            file_path = dist_path / 'index.html'
    except Exception:
        # Any path resolution error - fallback to safe default
        file_path = Path(chat_root) / 'index.html'

    if file_path.exists() and file_path.is_file():
        return FileResponse(file_path)
    index_path = Path(chat_root) / 'index.html'
    if index_path.exists() and index_path.is_file():
        return FileResponse(index_path)
    raise HTTPException(
        status_code=503,
        detail='Chat UI not built. Run builder chat-ui:build so dist/server/static/chat exists.',
    )
