# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Web Layer Package for the AI Service.

This package aggregates the core components needed to build and run the AI
service's HTTP/WebSocket interface using FastAPI. It imports and re-exports
everything that endpoint modules and application entry points need in a single
convenient namespace.

Included items:
    - FastAPI and its helpers (Request, Body, Header, Query, UploadFile, File)
    - CORSMiddleware for cross-origin request handling
    - Response helpers (response, error, error_dap, formatException, exception,
      ResultBase, Result) from the internal response module
    - WebServer — the top-level server class that wraps Uvicorn
    - AccountInfo — the account identity type used by authenticated endpoints
    - depends — the runtime dependency installer from the depends package
"""

import os
from depends import depends

# Resolve the path to this package's requirements.txt, located in the same
# directory as this __init__.py file, then ask the depends helper to ensure
# all listed packages are installed before any further imports run.
requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from fastapi import FastAPI, Request, Body, Header, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware

# Include the basic support
from ai.web.response import response, error, error_dap, formatException, exception, ResultBase, Result
from ai.web.server import WebServer

from ai.account import AccountInfo

__all__ = [
    'AccountInfo',
    'Body',
    'CORSMiddleware',
    'depends',
    'error',
    'error_dap',
    'exception',
    'FastAPI',
    'File',
    'formatException',
    'Header',
    'ObjectPipe',
    'Query',
    'Request',
    'response',
    'Result',
    'ResultBase',
    'UploadFile',
    'WebServer',
]
