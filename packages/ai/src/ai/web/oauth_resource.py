# Copyright 2026 Aparavi Software AG. MIT License.
"""RFC 9728 protected-resource metadata for the engine's OAuth-protected routes.

The MCP endpoint is an OAuth 2.0 protected resource. A spec-compliant client
(Claude, ChatGPT) that has never seen us before authenticates like this:

  1. It calls the resource with no credentials and gets a 401.
  2. It reads ``WWW-Authenticate: Bearer resource_metadata="..."`` off that 401.
  3. It fetches that metadata document to learn which authorization server
     guards the resource.
  4. It fetches the authorization server's own RFC 8414 metadata.
  5. It runs an OAuth 2.1 authorization-code + PKCE flow against it.

This module owns steps 2 and 3. Zitadel owns steps 4 and 5 and already serves
its RFC 8414 document at
``https://auth.rocketride.ai/.well-known/oauth-authorization-server``.

There is deliberately no token minting and no ``resource``-parameter translation
here. Zitadel stamps a client's own project id into the token's ``aud`` claim
automatically and discards the RFC 8707 ``resource`` parameter, so audience
binding is a downstream check against that claim — not something this layer
rewrites.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List
from urllib.parse import urlparse

# RFC 9728 fixes this prefix; the resource's own path is appended to it.
WELL_KNOWN_PREFIX = '/.well-known/oauth-protected-resource'

ENV_RESOURCE = 'MCP_RESOURCE_IDENTIFIER'
ENV_AUTH_SERVER = 'MCP_AUTHORIZATION_SERVER'

DEFAULT_RESOURCE_IDENTIFIER = 'https://api.rocketride.ai/mcp'
DEFAULT_AUTHORIZATION_SERVER = 'https://auth.rocketride.ai'


def resource_identifier() -> str:
    """Return the canonical OAuth resource identifier for the MCP endpoint.

    This exact string is what clients put in the RFC 8707 ``resource``
    parameter and what the metadata document advertises, so it must match the
    deployed URL byte for byte.

    Returns:
        str: The resource identifier, without a trailing slash.
    """
    return (os.environ.get(ENV_RESOURCE) or DEFAULT_RESOURCE_IDENTIFIER).rstrip('/')


def authorization_servers() -> List[str]:
    """Return the authorization servers permitted to issue tokens for us.

    Returns:
        List[str]: Issuer identifiers, without trailing slashes.
    """
    raw = os.environ.get(ENV_AUTH_SERVER) or DEFAULT_AUTHORIZATION_SERVER
    return [raw.rstrip('/')]


def resource_path() -> str:
    """Return the path component of the resource identifier.

    Returns:
        str: e.g. ``'/mcp'``, or ``''`` when the resource is a whole host.
    """
    return urlparse(resource_identifier()).path.rstrip('/')


def metadata_path(resource: str | None = None) -> str:
    """Derive the well-known path for a resource identifier (RFC 9728 3.1).

    The well-known segment is inserted between the host and the resource's
    path — it is not appended to the end::

        https://api.rocketride.ai/mcp
            -> /.well-known/oauth-protected-resource/mcp
        https://mcp.rocketride.ai
            -> /.well-known/oauth-protected-resource

    Args:
        resource: Resource identifier to derive from. Defaults to the
            configured one.

    Returns:
        str: The absolute path the document must be served at.
    """
    parsed = urlparse(resource.rstrip('/') if resource else resource_identifier())
    return f'{WELL_KNOWN_PREFIX}{parsed.path.rstrip("/")}'


def metadata_url(resource: str | None = None) -> str:
    """Return the fully-qualified URL of the metadata document.

    Args:
        resource: Resource identifier to derive from. Defaults to the
            configured one.

    Returns:
        str: Absolute https URL, suitable for the ``resource_metadata``
            challenge parameter.
    """
    parsed = urlparse(resource.rstrip('/') if resource else resource_identifier())
    return f'{parsed.scheme}://{parsed.netloc}{metadata_path(resource)}'


def protected_resource_metadata() -> Dict[str, Any]:
    """Build the RFC 9728 protected-resource metadata document.

    Returns:
        Dict[str, Any]: The JSON body served at :func:`metadata_path`.
    """
    return {
        'resource': resource_identifier(),
        'authorization_servers': authorization_servers(),
        'bearer_methods_supported': ['header'],
        'scopes_supported': ['openid', 'profile', 'email'],
        'resource_name': 'RocketRide MCP',
    }


def covers_request_path(path: str) -> bool:
    """Report whether a request path belongs to the protected resource.

    Used to scope the ``WWW-Authenticate`` challenge: advertising MCP's
    metadata on unrelated engine routes would misdirect clients.

    Args:
        path: Request path, e.g. ``'/mcp'``.

    Returns:
        bool: True when the path is the resource or lives beneath it. When the
            resource is a bare host, every path is covered.
    """
    base = resource_path()
    if not base:
        return True
    return path == base or path.startswith(f'{base}/')


def www_authenticate_value(error: str | None = None, description: str = '') -> str:
    """Build the ``WWW-Authenticate`` challenge for a 401 on this resource.

    Args:
        error: RFC 6750 error code, e.g. ``'invalid_token'``. Omitted when the
            client simply sent no credentials — RFC 6750 3.1 says a challenge
            for a missing token carries no error code.
        description: Human-readable detail. Quotes and backslashes are stripped
            so the header stays parseable.

    Returns:
        str: e.g. ``Bearer resource_metadata="https://.../mcp"``.
    """
    parts = [f'resource_metadata="{metadata_url()}"']
    if error:
        parts.insert(0, f'error="{error}"')
        if description:
            safe = description.replace('"', '').replace('\\', '')
            parts.insert(1, f'error_description="{safe}"')
    return 'Bearer ' + ', '.join(parts)


def register_routes(server: Any) -> str:
    """Mount the RFC 9728 metadata document as a public route.

    The document must be reachable without credentials — it is what a client
    reads in order to *learn how* to authenticate. Registering through
    ``server.add_route(..., public=True)`` is what puts it on the auth
    middleware's bypass list; appending a raw Starlette route would leave it
    behind auth and deadlock discovery.

    Args:
        server: The WebServer exposing ``add_route``.

    Returns:
        str: The path the document was registered at.
    """
    path = metadata_path()

    async def oauth_protected_resource() -> Dict[str, Any]:
        """Serve the OAuth 2.0 protected-resource metadata document."""
        return protected_resource_metadata()

    server.add_route(path, oauth_protected_resource, ['GET'], public=True)
    return path
