# MIT License
# Copyright (c) 2026 Aparavi Software AG

"""
WebServer — FastAPI/Uvicorn wrapper for AI service HTTP endpoints.
"""

import os
import sys
import urllib.parse
import uvicorn
import asyncio
import importlib
import time
from dotenv import load_dotenv
from contextlib import asynccontextmanager
from typing import Dict, Any, Callable, Awaitable, List, Optional, Union, Tuple
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.routing import compile_path
from rocketlib import debug
from rocketride import CONST_WS_PING_INTERVAL, CONST_WS_PING_TIMEOUT
from ai.constants import CONST_DEFAULT_WEB_PORT, CONST_DEFAULT_WEB_HOST, CONST_WEB_WS_MAX_SIZE
from ai.web import exception, error, Result
from ai.account import account, AccountInfo, Reporter
from ai.modules import ALL as ALLOWED_MODULES
from .middleware import AuthMiddleware
from .endpoints import use, ping, version, shutdown, status, auth_callback
from .denied import (
    CONST_ACCESS_DENIED_HTML,
    CONST_ACCESS_DENIED_TEXT,
    CONST_OTHER_HTML,
    CONST_OTHER_TEXT,
)

__all__ = ['WebServer', 'AccountInfo']

logo = r"""
        _____            _        _   _____  _     _
       |  __ \          | |      | | |  __ \(_)   | |
       | |__) |___   ___| | _____| |_| |__) |_  __| | ___
       |  _  // _ \ / __| |/ / _ \ __|  _  /| |/ _` |/ _ \
       | | \ \ (_) | (__|   <  __/ |_| | \ \| | (_| |  __/
       |_|  \_\___/ \___|_|\_\___|\__|_|  \_\_|\__,_|\___|


            Copyright (c) 2026 Aparavi Software AG
                    All rights reserved
    """


@asynccontextmanager
async def _lifespan(app: FastAPI):
    await app.state.server._on_startup()
    yield
    await app.state.server._on_shutdown()


class WebServer:
    """Manage and run a FastAPI web server with exception handling, SSL support, and event loop management."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, **kwargs):
        exec_dir = os.path.dirname(sys.executable)
        load_dotenv(dotenv_path=exec_dir + '/.env')

        self._authenticators: List[Callable[[str], Awaitable[Optional[AccountInfo]]]] = []
        self._user_shutdown = kwargs.get('on_shutdown', None)
        self._user_startup = kwargs.get('on_startup', None)
        self._statusCallbacks: List[Callable[[Dict[str, any]], None]] = []
        self._startTime = None

        title = kwargs.get('title', 'RocketRide Web Services')
        webversion = kwargs.get('version', '0.1.0')

        self.app = FastAPI(title=title, version=webversion, lifespan=_lifespan)

        register_standard_endpoints = kwargs.get('standardEndpoints', True)

        self._private_paths = []
        self._public_paths = ['/redoc', '/openapi.json']
        self._compiled_public_paths = None
        self._compiled_private_paths = None

        self.app.add_middleware(AuthMiddleware)

        self._port = None

        # ── CORS configuration (F-07 fix) ─────────────────────────────────
        # Require RR_CORS_ORIGINS to be explicitly set in production.
        # Default is now a closed/deny-all policy instead of wildcard '*'.
        # Log a startup warning when the env var is absent so misconfigured
        # deployments are immediately visible in server logs.
        cors_origins_env = os.environ.get('RR_CORS_ORIGINS', '')
        if cors_origins_env:
            cors_origins = [o.strip() for o in cors_origins_env.split(',') if o.strip()]
            allow_credentials = True
        else:
            # F-07 fix: previously defaulted to ['*'] with allow_credentials=False.
            # Now defaults to an empty list (no cross-origin requests allowed) so
            # deployments that forget to set RR_CORS_ORIGINS fail closed, not open.
            cors_origins = []
            allow_credentials = False
            debug(
                'WARNING: RR_CORS_ORIGINS is not set. '
                'Cross-origin requests will be denied by default. '
                'Set RR_CORS_ORIGINS to a comma-separated list of allowed origins '
                '(e.g. RR_CORS_ORIGINS=https://app.example.com) to enable CORS.'
            )

        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=allow_credentials,
            allow_methods=['*'],
            allow_headers=['*'],
        )

        self.config = config if config is not None else {}

        self.app.exception_handler(Exception)(self._general_exception_handler)
        self.app.openapi_schema = None
        self.app.state.server = self
        self.app.state.modules = {}

        if register_standard_endpoints:
            self.add_route('/ping', ping, ['GET'], public=True)
            self.add_route('/use', use, ['POST'])
            self.add_route('/shutdown', shutdown, ['POST'])
            self.add_route('/auth/callback', auth_callback, ['GET'], public=True)

        self.add_route('/status', status, ['GET'])
        self.add_route('/version', version, ['GET'], public=True)

        self.server = self._configure_server()
        self.account = account
        self.report = Reporter()

    def _get_file_path(self, path: str):
        if path is None:
            return None

        decoded_path = urllib.parse.unquote(path)
        resolved_path = os.path.realpath(decoded_path)

        if not os.path.isabs(resolved_path):
            raise ValueError(f'File path must be absolute: {path}')

        if '..' in resolved_path.split(os.sep):
            raise ValueError(f'Path traversal detected in: {path}')

        if os.path.exists(resolved_path):
            return resolved_path
        else:
            raise FileNotFoundError(f'File {path} not found')

    async def _general_exception_handler(self, request: Request, exc: Exception) -> Result:
        return exception(exc)

    def _format_request_error(self, request, message: str = 'Access denied', status_code: int = 401):
        accept_type = (request.headers.get('accept') or '').lower()

        if 'text/html' in accept_type:
            html_template = CONST_ACCESS_DENIED_HTML if status_code == 401 else CONST_OTHER_HTML
            return HTMLResponse(content=html_template.format(message), status_code=status_code)
        elif 'text/plain' in accept_type:
            text_template = CONST_ACCESS_DENIED_TEXT if status_code == 401 else CONST_OTHER_TEXT
            return PlainTextResponse(content=text_template.format(message), status_code=status_code)
        else:
            text_template = CONST_ACCESS_DENIED_TEXT if status_code == 401 else CONST_OTHER_TEXT
            return error(message=text_template.format(message), httpStatus=status_code)

    def _configure_server(self):
        ssl_certfile = self._get_file_path(self.config.get('tlsCertFile', None))
        ssl_keyfile = self._get_file_path(self.config.get('tlsKeyFile', None))

        port = self.config.get('port', CONST_DEFAULT_WEB_PORT)
        host = self.config.get('host', CONST_DEFAULT_WEB_HOST)
        self._port = port

        config = uvicorn.Config(
            self.app,
            log_level='info',
            host=host,
            port=port,
            ssl_keyfile=ssl_keyfile,
            ssl_certfile=ssl_certfile,
            ws_max_size=CONST_WEB_WS_MAX_SIZE,
            ws_ping_interval=CONST_WS_PING_INTERVAL,
            ws_ping_timeout=CONST_WS_PING_TIMEOUT,
        )

        return uvicorn.Server(config)

    async def _on_startup(self):
        self.eventLoop = asyncio.get_running_loop()
        if self._user_startup is not None:
            await self._user_startup()

    async def _on_shutdown(self):
        if self._user_shutdown is not None:
            await self._user_shutdown()

    async def _authenticate_credential_inner(self, authorization: str) -> Union[AccountInfo, Tuple[int, str]]:
        for authenticator in self._authenticators:
            try:
                account_info = await authenticator(authorization)
                if not account_info:
                    continue
                return account_info
            except PermissionError as e:
                return (401, str(e))
            except Exception as e:
                return (400, str(e))

        try:
            account_info = await self.account.authenticate(authorization)
            if not account_info:
                return (401, 'Invalid authorization provided')
            return account_info
        except Exception as e:
            return (400, str(e))

    async def authenticate_request(
        self,
        request: Request,
        return_tuple: bool = False,
    ) -> Optional[Union[Response, Tuple[int, str]]]:
        """Authenticate incoming requests using registered authentication providers."""

        def _format_error(message, error_code, html_message, text_message):
            if return_tuple:
                return (error_code, message)

            content_type = request.headers.get('Content-Type', 'application/json').lower()
            accept_type = request.headers.get('Accept', '').lower()

            if not accept_type or accept_type == '*/*':
                accept_type = content_type

            if accept_type.startswith('text/html'):
                return HTMLResponse(content=html_message.format(message), status_code=error_code)
            elif accept_type.startswith('text/plain'):
                return PlainTextResponse(content=text_message.format(message), status_code=error_code)
            else:
                return error(message=text_message.format(message), httpStatus=error_code)

        def _format_auth_error(message):
            return _format_error(message, 401, CONST_ACCESS_DENIED_HTML, CONST_ACCESS_DENIED_TEXT)

        # Check public paths
        if self._compiled_public_paths:
            for pattern in self._compiled_public_paths:
                if pattern.match(request.url.path):
                    return None

        # Check private paths that require auth
        if self._compiled_private_paths:
            matched_private = any(p.match(request.url.path) for p in self._compiled_private_paths)
            if not matched_private:
                return None

        # Extract credential
        authorization = request.headers.get('Authorization', '')
        if authorization.lower().startswith('bearer '):
            authorization = authorization[7:]

        if not authorization:
            authorization = request.query_params.get('auth', '')

        if not authorization:
            return _format_auth_error('No authorization provided')

        result = await self._authenticate_credential_inner(authorization)

        if isinstance(result, tuple):
            code, msg = result
            return _format_error(msg, code, CONST_ACCESS_DENIED_HTML, CONST_ACCESS_DENIED_TEXT)

        request.state.account = result
        return None

    def add_route(self, path: str, handler, methods: List[str], public: bool = False):
        """Register an HTTP route."""
        self.app.add_api_route(path, handler, methods=methods)
        if public:
            self._public_paths.append(path)
            self._compiled_public_paths = [compile_path(p)[0] for p in self._public_paths]
        else:
            self._private_paths.append(path)
            self._compiled_private_paths = [compile_path(p)[0] for p in self._private_paths]

    def add_websocket(self, path: str, handler, public: bool = False):
        """Register a WebSocket endpoint."""
        self.app.add_api_websocket_route(path, handler)
        if public:
            self._public_paths.append(path)
            self._compiled_public_paths = [compile_path(p)[0] for p in self._public_paths]

    def add_status_callback(self, callback: Callable[[Dict[str, Any]], None]):
        """Register a status callback."""
        self._statusCallbacks.append(callback)

    def add_authenticator(self, authenticator: Callable[[str], Awaitable[Optional[AccountInfo]]]):
        """Register an additional authenticator in the chain."""
        self._authenticators.append(authenticator)

    def use(self, module_name: str, *args, **kwargs):
        """Dynamically load and activate a module."""
        mod = importlib.import_module(module_name)
        if hasattr(mod, 'register'):
            mod.register(self, *args, **kwargs)
        self.app.state.modules[module_name] = mod
        return mod

    def run(self):
        """Run the server (blocking)."""
        print(logo)
        self._startTime = time.time()
        asyncio.run(self.serve())

    async def serve(self):
        """Run the server inside an existing event loop."""
        self._startTime = time.time()
        await self.server.serve()
