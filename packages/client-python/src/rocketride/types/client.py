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
Client Type Definitions for RocketRide Client.

This module provides TypedDict classes and type aliases for type-safe client configuration,
DAP (Debug Adapter Protocol) messages, and callback signatures. These types improve code
completion, enable static type checking, and document expected data structures.

Types Defined:
    DAPMessage: Core message structure for client-server communication
    TransportCallbacks: Callback hooks for transport layer events
    ConnectionInfo: Connection configuration for server endpoints
    RocketRideClientConfig: Complete client configuration options
    EventCallback: Type alias for event handling callbacks
    ConnectCallback: Type alias for connection callbacks
    ConnectErrorCallback: Type alias for connection attempt failure callbacks
    DisconnectCallback: Type alias for disconnection callbacks
    TraceInfo: Stack trace information for debugging errors

These types are compatible with Python 3.10+ using native typing without extensions.

Usage:
    from rocketride.types import RocketRideClientConfig, EventCallback

    # Type-safe configuration
    config: RocketRideClientConfig = {
        'auth': 'your_api_key',
        'uri': 'wss://server.example.com',
        'onEvent': my_event_handler
    }

    # Type hints for callbacks
    async def handle_event(event: DAPMessage) -> None:
        print(f"Event: {event['event']}")
"""

from typing import Any, Callable, Awaitable, TypedDict, Literal, Optional, Union


class TraceInfo(TypedDict):
    """
    Stack trace information attached to error responses.

    Attributes:
        file (str): The source file path where the error originated.
        lineno (int): The line number within that source file.
    """

    file: str
    lineno: int


class DAPMessage(TypedDict, total=False):
    """
    Core message structure for Debug Adapter Protocol (DAP) communication.

    Used for all client-server communication including requests, responses,
    and events. Supports both text and binary data transmission through
    the DAP protocol format.

    Note: Using total=False makes all fields optional by default.
    Required fields are documented in comments.
    """

    # Required fields (must be present in all messages)
    type: Literal['request', 'response', 'event']  # REQUIRED
    seq: int  # REQUIRED

    # Optional fields
    command: str  # Command name for requests (e.g., 'execute', 'terminate', 'rrext_ping')
    arguments: dict[str, Any]  # Command arguments and parameters
    body: dict[str, Any]  # Response body containing results and data
    success: bool  # Success flag for responses - true if operation succeeded
    message: str  # Error or status message
    request_seq: int  # Sequence number of the request this response corresponds to
    event: str  # Event type name for event messages
    token: str  # Task or pipeline token for operation context
    data: Union[bytes, str]  # Binary or text data payload
    trace: TraceInfo  # Stack trace information for errors


class DAPRequest(TypedDict, total=False):
    """
    A DAP request message sent from client to server.

    Requests carry a ``command`` and optional ``arguments``.  The server
    responds with a ``DAPResponse`` whose ``request_seq`` matches the
    request's ``seq``.

    Required fields: ``type`` (always ``'request'``), ``seq``, ``command``.
    """

    # Required fields
    type: Literal['request']  # Always 'request'
    seq: int  # Unique sequence number for correlation
    command: str  # Command name (e.g. 'execute', 'rrext_account_me')

    # Optional fields
    arguments: dict[str, Any]  # Command-specific parameters
    token: str  # Task or pipeline token for operation context


class DAPResponse(TypedDict, total=False):
    """
    A DAP response message sent from server to client.

    Every response corresponds to a request identified by ``request_seq``.
    ``success`` indicates whether the command succeeded; on failure
    ``message`` carries the error description.

    Required fields: ``type`` (always ``'response'``), ``seq``,
    ``request_seq``, ``command``, ``success``.
    """

    # Required fields
    type: Literal['response']  # Always 'response'
    seq: int  # Sequence number of this response
    request_seq: int  # Sequence number of the original request
    command: str  # Command this response corresponds to
    success: bool  # True if the command succeeded

    # Optional fields
    body: dict[str, Any]  # Response payload
    message: str  # Error description when success is False
    arguments: dict[str, Any]  # Additional data (e.g. binary payloads)
    trace: TraceInfo  # Stack trace on error


class DAPEvent(TypedDict, total=False):
    """
    A DAP event message sent from server to client.

    Events are server-initiated notifications about state changes,
    output, or other asynchronous occurrences.

    Required fields: ``type`` (always ``'event'``), ``seq``, ``event``.
    """

    # Required fields
    type: Literal['event']  # Always 'event'
    seq: int  # Sequence number of this event
    event: str  # Event type name (e.g. 'apaevt_status_update')

    # Optional fields
    body: dict[str, Any]  # Event-specific payload
    id: str  # Optional event correlation ID


class TransportCallbacks(TypedDict, total=False):
    """
    Callback functions for transport layer events and debugging.

    These callbacks provide hooks for monitoring transport activity,
    debugging protocol messages, and handling connection lifecycle events.
    """

    onDebugMessage: Callable[[str], None]  # Called when debug messages are generated
    onDebugProtocol: Callable[[str], None]  # Called when protocol messages are sent/received for debugging
    onReceive: Callable[[DAPMessage], Awaitable[None]]  # Called when a message is received from the server
    onConnected: Callable[[Optional[str]], Awaitable[None]]  # Called when connection is established
    onDisconnected: Callable[
        [Optional[str], Optional[bool]], Awaitable[None]
    ]  # Called when connection is lost or closed


class ConnectionInfo(TypedDict):
    """
    Connection configuration for establishing server connections.

    Note: uri is required, auth is optional.
    """

    uri: str  # Server URI (WebSocket endpoint) - REQUIRED
    auth: Optional[str]  # Authentication token or API key - OPTIONAL


# =============================================================================
# CALLBACK TYPE ALIASES
# These Callable type aliases are not TypedDicts; they are simple type aliases
# used to annotate callback parameters and attributes across the SDK.
# =============================================================================

# Type aliases for callback functions
"""
Callback function for handling real-time events from the server.

Events include pipeline status updates, processing progress,
error notifications, and system alerts.
"""
EventCallback = Callable[[DAPMessage], Awaitable[None]]

"""Callback function for connection establishment events."""
ConnectCallback = Callable[[Optional[str]], Awaitable[None]]

"""Callback function for connection attempt failure (e.g. connect or reconnect failed). Async."""
ConnectErrorCallback = Callable[[str], Awaitable[None]]

"""Callback function for disconnection events."""
DisconnectCallback = Callable[[Optional[str], Optional[bool]], Awaitable[None]]


class RocketRideClientConfig(TypedDict, total=False):
    """
    Configuration options for creating an RocketRideClient instance.

    Provides connection settings, authentication, and event handling
    configuration for establishing and managing server connections.

    All fields are optional.
    """

    # Connection
    auth: str  # API authentication key or token
    uri: str  # Server URI (will be converted to WebSocket URI automatically)

    # Environment variables for pipeline config substitution.
    # If not provided, loads values from `.env`.
    env: dict[str, str]

    # Callbacks
    on_event: EventCallback  # Callback for handling real-time events from server
    on_connected: ConnectCallback  # Callback for connection establishment
    on_connect_error: ConnectErrorCallback  # Callback for connection attempt failure (persist mode)
    on_disconnected: DisconnectCallback  # Callback for disconnection events

    # Debug / logging
    on_protocol_message: Callable[[str], None]  # Optional function to output protocol messages
    on_debug_message: Callable[[str], None]  # Optional function to output debug messages
    module: str  # Client module name for debugging and identification

    # Connection behavior
    persist: bool  # Enable automatic reconnection with exponential backoff (default: False)
    request_timeout: float  # Default timeout in ms for individual requests (default: None/no timeout)
    max_retry_time: float  # Max total time in ms to keep retrying connections (default: None/forever)


# =============================================================================
# CONNECT RESULT — returned by connect() after successful authentication
# =============================================================================


class TeamInfo(TypedDict):
    """
    Information about a single team within an organisation.

    Attributes:
        id (str): Unique identifier for the team.
        name (str): Human-readable display name.
        permissions (list[str]): Permission strings granted to this team.
    """

    id: str
    name: str
    permissions: list[str]


class OrgInfo(TypedDict):
    """
    Information about a single organisation the authenticated user belongs to.

    Attributes:
        id (str): Unique identifier for the organisation.
        name (str): Human-readable display name.
        permissions (list[str]): Permission strings granted at the org level.
        teams (list[TeamInfo]): Teams within this organisation that the user is a member of.
    """

    id: str
    name: str
    permissions: list[str]
    teams: list[TeamInfo]


class AppManifestEntry(TypedDict, total=False):
    """
    A single app entry in the server-provided manifest.

    Same shape as the build-time apps.json entries, extended with
    optional pricing and visibility metadata for SaaS deployments.
    When returned as a desktop app in ConnectResult.apps, also includes
    subscription status fields.

    Attributes:
        id (str): Unique app identifier (e.g. "rocketride.pipeBuilder").
        moduleId (str): Module Federation remote name.
        name (str): Human-readable app name.
        description (str): Short description.
        icon (str): URL path to the app's icon.
        categories (list[str]): Category tags for filtering.
        settings (list): App-specific setting definitions.
        entry (str): URL to the app's MF remote entry file.
        version (str): Semver version string.
        ownerType (str): Visibility scope — "public", "org", "team", or "user".
        authenticated (bool): Whether the app UI requires auth to render.
        public (bool): Whether the app is visible to unauthenticated users.
        stripeProductId (str): Stripe product ID (SaaS paid apps only).
        stripePrices (list): Available pricing tiers (SaaS paid apps only).
        appStatus (str): App lifecycle status (auth|free|unsubscribed|subscribed|trialing|past_due|canceled).
        onDesktop (bool): Whether this app is on the user's desktop.
        seats (int): Total seats on the subscription.
        seatsUsed (int): Seats currently occupied in this org.
        features (list[str]): Feature flags enabled by the subscribed plan.
    """

    id: str
    moduleId: str
    name: str
    description: str
    icon: str
    categories: list[str]
    settings: list
    entry: str
    version: str
    ownerType: str
    authenticated: bool
    public: bool
    stripeProductId: str
    stripePrices: list[dict]
    appStatus: str
    onDesktop: bool
    seats: int
    seatsUsed: int
    features: list[str]


class ConnectResult(TypedDict, total=False):
    """
    Full identity payload returned by the server after a successful authentication handshake.

    All fields are optional (total=False) because older server versions may omit some.

    Attributes:
        userToken (str): A durable ``rr_`` prefixed token the SDK persists for reconnection.
        userId (str): Unique identifier of the authenticated user.
        displayName (str): Full display name (e.g. "Jane Smith").
        givenName (str): First / given name.
        familyName (str): Last / family name.
        preferredUsername (str): Preferred short username or handle.
        email (str): Primary email address.
        emailVerified (bool): True when the email address has been verified.
        phoneNumber (str): Primary phone number in E.164 format.
        phoneNumberVerified (bool): True when the phone number has been verified.
        locale (str): BCP-47 locale tag (e.g. "en-US").
        defaultTeam (str): ID of the team selected as the default context.
        organization (OrgInfo | None): The organisation the user belongs to, or None.
        waitlisted (bool): True when authenticated but not yet granted full app access.
    """

    userToken: str
    userId: str
    displayName: str
    givenName: str
    familyName: str
    preferredUsername: str
    email: str
    emailVerified: bool
    phoneNumber: str
    phoneNumberVerified: bool
    locale: str
    defaultTeam: str
    organization: OrgInfo
    capabilities: list[str]
    sysPermissions: list[str]
    waitlisted: bool
    # Per-app subscription status keyed by appId ('subscribed' | 'trialing' |
    # 'free' | 'unsubscribed' | 'past_due' | 'canceled' | 'auth'). Lightweight
    # source for subscription gating; SaaS populates from billing, OSS = 'free'.
    subscriptions: dict[str, str]


class ServerInfoResult(TypedDict, total=False):
    """
    Server metadata returned by the pre-auth info probe.

    Obtained via :meth:`RocketRideClient.get_server_info` which sends an
    ``rrext_public_probe`` command on a public connection. The server
    responds without requiring credentials.

    Attributes:
        version (str): Server engine version string.
        capabilities (list[str]): Capability tags — ``['oss']`` for open-source,
            ``['saas']`` for cloud.
        platform (str): Server platform (e.g. ``'linux'``, ``'win32'``, ``'darwin'``).
    """

    version: str
    capabilities: list[str]
    platform: str
