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
from ai.constants import CONST_DEFAULT_WEB_PORT, CONST_DEFAULT_WEB_HOST, CONST_WEB_WS_MAX_SIZE
from rocketride import CONST_WS_PING_INTERVAL, CONST_WS_PING_TIMEOUT
from ai.web import exception, error, Result
from ai.account import Account, AccountInfo, Reporter
from .middleware import AuthMiddleware
from .endpoints import use, ping, version, shutdown, status
from .denied import (
    CONST_ACCESS_DENIED_HTML,
    CONST_ACCESS_DENIED_TEXT,
    CONST_OTHER_HTML,
    CONST_OTHER_TEXT,
)

__all__ = ['WebServer', 'AccountInfo']

# Remove event loop - use default which should be ProactorEventLoop
# # Check if running on Windows
# if platform.system() == 'Windows':
#     # Windows needs SelectorEventLoop for stability when spawning processes
#     asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

logo = r"""
        _____            _        _   _____  _     _      
       |  __ \          | |      | | |  __ \(_)   | |     
       | |__) |___   ___| | _____| |_| |__) |_  __| | ___ 
       |  _  // _ \ / __| |/ / _ \ __|  _  /| |/ _` |/ _ \
       | | \ \ (_) | (__|   <  __/ |_| | \ \| | (_| |  __/
       |_|  \_\___/ \___|_|\_\___|\__|_|  \_\_|\__,_|\___|
                                                    
                                                    
            Copyright (c) 2026, RocketRide Foundation, Inc
                    All rights reserved
    """

@asynccontextmanager
async def _lifespan(app: FastAPI):
    # Call the startup method
    await app.state.server._on_startup()
    yield
    # Call the shutdown method
    await app.state.server._on_shutdown()


class WebServer:
    """
    Manage and run a FastAPI web server with exception handling, SSL support, and event loop management.
    """

    def __init__(self, config: Dict[str, Any] = {}, **kwargs):
        """
        Initialize the WebServer instance with the FastAPI app and configuration.

        Args:
            config (Dict[str, Any], optional):
                Configuration parameters for the server.
                - "tlsCertFile" (str, optional): Path to the SSL certificate file.
                - "tlsKeyFile" (str, optional): Path to the SSL key file.
                - "port" (int, optional): Port number to run the server on (default: 5565).
                - "host" (str, optional): Hostname or IP address to bind to (default: "0.0.0.0").

            kwargs (Any, optional): Additional optional parameters.
                - "app" (FastAPI, optional): A pre-existing FastAPI instance. If not provided, a new one is created.
                - "title" (str, optional): Title of the API (used if a new FastAPI instance is created).
                - "version" (str, optional): API version (used if a new FastAPI instance is created).
                - "on_startup" (Callable[[], Awaitable[None]], optional): A callback function to run on server startup.
                - "on_shutdown" (Callable[[], Awaitable[None]], optional): A callback function to run on server shutdown.

        Attributes:
            app (FastAPI): The FastAPI instance, either user-provided or created internally.
            config (Dict[str, Any]): The server configuration dictionary.
            loop (asyncio.AbstractEventLoop): The event loop for handling async tasks.
            server (uvicorn.Server): The configured Uvicorn server instance.

        Behavior:
            - If an `app` is provided in `kwargs`, it is used. Otherwise, a new FastAPI app is created.
            - CORS middleware is added to allow unrestricted API access.
            - The OpenAPI schema is reset to avoid caching issues.
            - The Uvicorn server is configured immediately.
            - The event loop is stored for handling asynchronous operations.
        """
        # Directory containing engine.exe
        exec_dir = os.path.dirname(sys.executable)

        # Do this early on to read the .env file and put it in the environment
        load_dotenv(dotenv_path=exec_dir + '/.env')

        # Authenticators, given an authorization string, return a structure of the decode key info
        self._authenticators: List[Callable[[str], Awaitable[Optional[AccountInfo]]]] = []

        # Save the users startup/shutdown callbacks
        self._user_shutdown = kwargs.get('on_shutdown', None)
        self._user_startup = kwargs.get('on_startup', None)

        # Define our callbacks to gather status information
        self._statusCallbacks: List[Callable[[Dict[str, any]], None]] = []
        self._startTime = None

        # Create a new one web app
        title = kwargs.get('title', 'RocketRide Web Services')
        webversion = kwargs.get('version', '0.1.0')

        # Create a new FastAPI app instance with the specified title and version
        self.app = FastAPI(title=title, version=webversion, lifespan=_lifespan)

        # See if we need standard endpoints added
        register_standard_endpoints = kwargs.get('standardEndpoints', True)

        # Define the basic public endpoints
        self._private_paths = []
        self._public_paths = ['/redoc', '/openapi.json']
        self._compiled_public_paths = None
        self._compiled_private_paths = None

        # Add our metrics middleware to the app
        self.app.add_middleware(AuthMiddleware)

        # Declare the port
        self._port = None

        # Add CORS middleware to allow unrestricted API access
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=['*'],  # Allows all origins (not recommended for production)
            allow_credentials=True,  # Allows cookies and authentication credentials
            allow_methods=['*'],  # Allows all HTTP methods (GET, POST, PUT, etc.)
            allow_headers=['*'],  # Allows all HTTP headers
        )

        # Store the server configuration
        self.config = config

        # Register a global exception handler for catching unexpected errors
        self.app.exception_handler(Exception)(self._general_exception_handler)

        # Reset the OpenAPI schema to avoid caching issues
        self.app.openapi_schema = None

        # Save our server
        self.app.state.server = self

        # Store the modules that are loaded
        self.app.state.modules = {}

        # Add the our two management routes
        if register_standard_endpoints:
            self.add_route('/ping', ping, ['GET'], public=True)
            self.add_route('/use', use, ['POST'])
            self.add_route('/shutdown', shutdown, ['POST'])

        # These are always there - no way to turn them off
        self.add_route('/status', status, ['GET'])
        self.add_route('/version', version, ['GET'], public=True)

        # Configure the Uvicorn server immediately upon initialization
        self.server = self._configure_server()

        # Setup our accounting info
        self.account = Account()
        self.report = Reporter()

        # Don't pass on to super as this is the final class
        return

    def _get_file_path(self, path: str):
        """
        Resolve the absolute file path from a URL-encoded path.

        Args:
            path (str): The file path (can be URL-encoded).

        Returns:
            str: The absolute path if it exists.

        Raises:
            FileNotFoundError: If the file does not exist.

        Behavior:
            - Decodes URL-encoded file paths.
            - Checks if the file path exists.
            - If the file does not exist, raises an exception.
        """
        if path is None:
            return None

        # Decode the URL-encoded path
        decoded_path = urllib.parse.unquote(path)

        # Return the valid file path if it exists
        if os.path.exists(decoded_path):
            return decoded_path
        elif os.path.exists(path):
            return path
        else:
            raise FileNotFoundError(f'File {path} not found')

    async def _general_exception_handler(self, request: Request, exc: Exception) -> Result:
        """
        Global exception handler for FastAPI. Captures unexpected errors and formats them in a structured response.

        Args:
            request (Request): The incoming HTTP request that triggered the exception.
            exc (Exception): The exception that was raised.

        Returns:
            exception
        """
        return exception(exc)

    def _format_request_error(self, request, message: str = 'Access denied', status_code: int = 401):
        """
        Format an HTTP error response according to the client's 'Accept' header.

        Reuses existing templates (CONST_ACCESS_DENIED_*, CONST_OTHER_*) when available.
        """
        accept_type = (request.headers.get('accept') or '').lower()

        if 'text/html' in accept_type:
            html_template = CONST_ACCESS_DENIED_HTML if status_code == 401 else CONST_OTHER_HTML
            return HTMLResponse(
                content=html_template.format(message),
                status_code=status_code,
            )
        elif 'text/plain' in accept_type:
            text_template = CONST_ACCESS_DENIED_TEXT if status_code == 401 else CONST_OTHER_TEXT
            return PlainTextResponse(
                content=text_template.format(message),
                status_code=status_code,
            )
        else:
            text_template = CONST_ACCESS_DENIED_TEXT if status_code == 401 else CONST_OTHER_TEXT
            return error(
                message=text_template.format(message),
                httpStatus=status_code,
            )

    def _configure_server(self):
        """
        Configure and returns a Uvicorn Server instance.

        Returns:
            uvicorn.Server: The configured Uvicorn server instance.

        Behavior:
            - Retrieves configuration parameters for SSL/TLS and network settings.
            - Uses `_getFilePath()` to validate SSL certificate and key paths.
            - Creates and returns a `Uvicorn.Server` instance.
        """
        # Extract SSL certificate and key file paths
        ssl_certfile = self._get_file_path(self.config.get('tlsCertFile', None))
        ssl_keyfile = self._get_file_path(self.config.get('tlsKeyFile', None))

        # Get server host and port
        port = self.config.get('port', CONST_DEFAULT_WEB_PORT)
        host = self.config.get('host', CONST_DEFAULT_WEB_HOST)

        # Save the port
        self._port = port

        # Setup the Uvicorn configuration
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

        # Return the configured server instance
        return uvicorn.Server(config)

    async def _on_startup(self):
        """
        Perform any startup tasks required by the server.

        This method is called when the FastAPI application starts up.
        """
        # Save the event loop in case anyone needs it
        self.eventLoop = asyncio.get_running_loop()

        # If the user has a startup function
        if self._user_startup is not None:
            await self._user_startup()

    async def _on_shutdown(self):
        """
        Perform any shutdown tasks required by the server.

        This method is called when the FastAPI application shuts down.
        """
        if self._user_shutdown is not None:
            await self._user_shutdown()

    async def _authenticate_credential_inner(
        self, authorization: str
    ) -> Union[AccountInfo, Tuple[int, str]]:
        """
        Authenticate a normalized credential string (chain + account fallback).
        Returns AccountInfo on success, (error_code, error_message) on failure.
        """
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
        """
        Authenticate incoming requests using registered authentication providers.

        This method handles authentication for both HTTP and WebSocket requests using
        a chain-of-responsibility pattern. It attempts authentication through registered
        authenticators first, then falls back to the built-in account authenticator.

        Authentication Flow:
        1. Extract authorization from header or query parameter
        2. Try each registered authenticator in order
        3. If all fail, try built-in account authentication
        4. On success: Store account info in request.state and return None
        5. On failure: Return formatted error response

        Args:
            request (Request): FastAPI request object (HTTP or WebSocket)

        Returns:
            Optional[Response]:
                - None if authentication succeeds (account info stored in request.state.account)
                - Response object with error details if authentication fails

        Note:
            For WebSocket requests, the returned Response is used to reject the
            HTTP upgrade handshake with appropriate error details.

        Examples:
            >>> # In middleware
            >>> error_response = await server.authenticate_request(request)
            >>> if error_response:
            >>>     return error_response  # Authentication failed
            >>> # Otherwise continue - request.state.account contains AccountInfo
        """

        # ============================================================================
        # Helper Functions for Error Formatting
        # ============================================================================
        def _format_error(
            message: str,
            error_code: int,
            html_message: str,
            text_message: str,
        ) -> Response:
            """
            Format error response based on client's Accept header.

            Supports content negotiation to return errors in the format
            preferred by the client (HTML, plain text, or JSON).

            Args:
                message: Error message to send to client
                error_code: HTTP status code (e.g., 401, 400)
                html_message: HTML template with {} placeholder for message
                text_message: Plain text template with {} placeholder for message

            Returns:
                Response in the requested format (HTML, text, or JSON)
            """
            # If the caller wants the tuple directly, return it
            if return_tuple:
                return (error_code, message)

            # Determine what format the client wants based on Content-Type and Accept headers
            content_type = request.headers.get('Content-Type', 'application/json').lower()
            accept_type = request.headers.get('Accept', '').lower()

            # If no Accept header specified, use Content-Type as fallback
            if not accept_type or accept_type == '*/*':
                accept_type = content_type

            # Return response in requested format
            if accept_type.startswith('text/html'):
                return HTMLResponse(
                    content=html_message.format(message),
                    status_code=error_code,
                )
            elif accept_type.startswith('text/plain'):
                return PlainTextResponse(
                    content=text_message.format(message),
                    status_code=error_code,
                )
            else:
                # Default to JSON response
                return error(
                    message=text_message.format(message),
                    httpStatus=error_code,
                )

        def _format_auth_error(message: str) -> Response:
            """
            Format authentication error (401 Unauthorized).

            Args:
                message: Specific error message describing why auth failed

            Returns:
                Response with 401 status and formatted error message
            """
            return _format_error(
                message,
                error_code=401,
                text_message=CONST_ACCESS_DENIED_TEXT,
                html_message=CONST_ACCESS_DENIED_HTML,
            )

        def _format_other_error(message: str, error_code: int = 400) -> Response:
            """
            Format general error (400 Bad Request or other).

            Args:
                message: Specific error message
                error_code: HTTP status code (default: 400)

            Returns:
                Response with specified status code and formatted error message
            """
            return _format_error(
                message,
                error_code=error_code,
                text_message=CONST_OTHER_TEXT,
                html_message=CONST_OTHER_HTML,
            )

        # ============================================================================
        # Step 1: Extract Authorization Credentials
        # ============================================================================

        # Try to get authorization from the Authorization header (standard approach)
        authorization = request.headers.get('authorization', '')

        # Fallback: Check query parameters for 'auth' (used by browsers/WebSocket clients
        # that can't easily set custom headers)
        if not authorization:
            authorization = request.query_params.get('auth', None)

        # If no authorization credentials provided at all, reject immediately
        if not authorization:
            return _format_auth_error(message='No authorization provided')

        # Strip "Bearer " prefix if present (OAuth 2.0 convention)
        authorization = authorization.removeprefix('Bearer ').strip()

        # If credentials are empty after stripping, reject
        if not authorization:
            return _format_auth_error(message='No authorization provided')

        result = await self._authenticate_credential_inner(authorization)
        if isinstance(result, tuple):
            error_code, message = result
            if return_tuple:
                return result
            if error_code == 401:
                return _format_auth_error(message=message)
            return _format_other_error(message, error_code=error_code)
        request.state.account = result
        return None

    async def authenticate_credential(self, authorization: str) -> Union[AccountInfo, Tuple[int, str]]:
        """
        Authenticate using a raw credential string (e.g. from DAP auth command).

        Used when the credential is not on the request (e.g. first WebSocket
        message after connect). Runs the same authenticator chain and account
        authentication as authenticate_request(request).

        Args:
            authorization: Credential string (api key, token, etc.)

        Returns:
            AccountInfo on success; (error_code, error_message) on failure.
        """
        if not authorization:
            return (401, 'No authorization provided')
        authorization = authorization.removeprefix('Bearer ').strip()
        if not authorization:
            return (401, 'No authorization provided')
        return await self._authenticate_credential_inner(authorization)

    def get_port(self) -> int:
        """
        Get the port number on which the server is running.

        Returns:
            int: The port number.

        Example:
            >>> port = get_port()
            5565
        """
        return self._port

    def registerStatusCallback(self, callback: Callable[[Dict[str, any]], None]) -> None:
        """
        Register a callback function to be called to gather the server status.
        """
        self._statusCallbacks.append(callback)

    async def report(self, apikey: str, token: str, metrics: Dict[str, Any]) -> None:
        """
        Report data to the server using the provided API key.

        Args:
            apikey (str): The API key for authentication.
            metrics (Dict[str, Any]): The data to be reported.

        Behavior:
            - This function is a placeholder and should be implemented in subclasses.
            - It is expected to send the data to a remote server or service.

        Example:
            >>> report('abc123', {'key': 'value'})
        """
        debug(f'REPORT: apikey={apikey}, metrics={metrics}')
        return

    def is_public_route(self, path: str) -> bool:
        """
        Check if a given path is a public route that does not require authorization.

        Args:
            path (str): The URL path to check (e.g., "/process").

        Returns:
            bool: True if the path is a public endpoint, False otherwise.
        """
        # Pre-compile public routes for efficiency
        if self._compiled_public_paths is None:
            self._compiled_public_paths = []

            # Add all of our patterns
            for pattern in self._public_paths:
                regex, _, _ = compile_path(pattern)
                self._compiled_public_paths.append(regex)

            # # For any well knowns, we will add them to public, so they get a not found,
            # # not an unauthorized error. Anything the we do service, great, if not okay as well
            # regex, _, _ = compile_path('/.well-known/{path:path}')
            # self._compiled_public_paths.append(regex)

        # Precompiled the private routes for efficiency
        if self._compiled_private_paths is None:
            self._compiled_private_paths = []

            # Add all of our patterns
            for pattern in self._private_paths:
                regex, _, _ = compile_path(pattern)
                self._compiled_private_paths.append(regex)

        # See if it specifically matches a private route
        for regex in self._compiled_private_paths:
            if regex.match(path):
                return False

        # Now, find out if this is public or not
        for regex in self._compiled_public_paths:
            if regex.match(path):
                return True
        return False

    def add_authenticator(
        self,
        authenticator: Callable[[str], Awaitable[Dict[str, Any]]],
    ):
        # Save it
        self._authenticators.append(authenticator)

    def add_route(
        self,
        path: str,
        routeHandler: Callable,
        methods: List[str],
        *,
        public: bool = False,
        private: bool = False,
        deprecated: bool = False,
    ):
        """
        Register a new API route in the FastAPI application.

        Args:
            path (str): The URL path for the new route (e.g., "/process").
            routeHandler (Callable): The function that handles requests to this route.
            methods (List[str]): A list of allowed HTTP methods (e.g., ["GET", "POST"]).
            public (bool): If True, the route is considered public and does not require authorization.
            recursive (bool): If public route, applies to all child routes as well.

        Behavior:
            - The function dynamically adds a new route to `app.router` at runtime.
            - Resets the OpenAPI schema to ensure that the new route is reflected in the API docs.

        Example:
            >>> server.addRoute('/hello', hello_handler, ['GET', 'POST'])
        """
        # Add the route to the FastAPI application's router
        self.app.router.add_api_route(path, routeHandler, methods=methods, deprecated=deprecated)

        # Reset the OpenAPI schema to reflect the new route in documentation
        self.app.openapi_schema = None

        if public:
            # If this is a public endpoint, add it to the public endpoints set
            self._public_paths.append(path)
            self._compiled_public_paths = None

        if private:
            # If this is a private endpoint, specifically add it to the private endpoints set
            self._private_paths.append(path)
            self._compiled_private_paths = None

    def add_socket(
        self,
        path: str,
        listener: Callable,
        *,
        public: bool = False,
        private: bool = False,
    ):
        """
        Register a new API websocket in the FastAPI application.

        Args:
            path (str): The URL path for the new route (e.g., "/process").
            listener (Callable): The function that accepts the socket connection request.
            public (bool): If True, the route is considered public and does not require authorization.
            recursive (bool): If public route, applies to all child routes as well.

        Behavior:
            - The function dynamically adds a new route to `app.router` at runtime.
            - Resets the OpenAPI schema to ensure that the new route is reflected in the API docs.

        Example:
            >>> server.addRoute('/hello', hello_handler, ['GET', 'POST'])
        """
        self.app.router.add_api_websocket_route(path, listener)

        # Reset the OpenAPI schema to reflect the new route in documentation
        self.app.openapi_schema = None

        if public:
            # If this is a public endpoint, add it to the public endpoints set
            self._public_paths.append(path)
            self._compiled_public_paths = None

        if private:
            # If this is a private endpoint, specifically add it to the private endpoints set
            self._private_paths.append(path)
            self._compiled_private_paths = None

    def use(self, moduleName: str, config: Dict[str, Any] = {}):
        """
        Dynamically loads a service module and enables its API endpoints.

        Args:
            module (str): The name of the service module to load.

        Returns:
            module: The loaded module instance.

        Behavior:
            - Uses `importlib.import_module()` to dynamically import a module.
            - The module is expected to exist within the `ai.modules.<module>.endpoints` namespace.
            - This allows API endpoints from the specified module to be registered dynamically.

        Example:
            >>> use('analytics')
            <module 'ai.modules.analytics.endpoints' from 'path/to/module.py'>
        """
        # Clean it up
        moduleName = moduleName.lower().strip()

        # If it is already loaded, return success
        if moduleName in self.app.state.modules:
            return

        # Dynamically import the module
        moduleHandle = importlib.import_module(f'ai.modules.{moduleName}')

        # Init the module and register the module's endpoints with the server
        moduleHandle.initModule(self, config)

        # Add it to the module handle
        self.app.state.modules[moduleName] = moduleHandle

    def stop(self):
        # Set the shutdown flag to True
        self.server.should_exit = True

    def run(self):
        """
        Start the FastAPI server with the pre-configured Uvicorn instance.

        run is to be used when we do not have a running asyncio event loop. If
        and event loop is running, use the .serve API.

        Behavior:
            - Ensures the server is configured before running.
            - Runs the Uvicorn server, blocking until it stops.

        Example:
            >>> server = WebServer(config)
            >>> server.run()
        """
        if self.server is None:
            raise RuntimeError('Server is not configured. Something went wrong during initialization.')

        # Get the server start time
        self._startTime = time.time()

        # Start the Uvicorn server
        self.server.run()

    async def serve(self):
        """
        Start the FastAPI server with the pre-configured Uvicorn instance.

        serve is to be used when we have a running asyncio event loop. If
        an event loop is not running, use the .run API.

        Behavior:
            - Ensures the server is configured before running.
            - Runs the Uvicorn server, blocking until it stops.

        Example:
            >>> server = WebServer(config)
            >>> server.run()
        """
        if self.server is None:
            raise RuntimeError('Server is not configured. Something went wrong during initialization.')

        # Get the server start time
        self._startTime = time.time()

        print(logo)

        # Start the Uvicorn server
        await self.server.serve()
