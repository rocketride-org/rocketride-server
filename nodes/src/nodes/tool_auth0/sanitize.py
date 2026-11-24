# =============================================================================
# RocketRide Engine
# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""Validate and filter Auth0 Management API responses."""

import ipaddress
import re

from .auth0_client import Auth0Error


_EXPLANATIONS = {
    'f': 'Login failed.',
    'fp': 'Login failed because the password was invalid.',
    'fu': 'Login failed because the username was invalid.',
    'limit_wc': 'Brute-force protection blocked logins from an IP address after repeated failed attempts against one account.',
    'limit_sul': 'The user was temporarily prevented from logging in after reaching the login limit from the same IP address.',
    'limit_mu': 'Login attempts were blocked by IP-based protection.',
}
_GENERIC = 'No specific diagnostic is available for this event type.'


def object_response(value):
    """Require an object response from Auth0."""
    if not isinstance(value, dict):
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid response.')
    return value


def list_response(value):
    """Require a list of object responses from Auth0."""
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid response.')
    return value


def bounded_text(value, maximum):
    """Reject malformed, oversized, or nonprintable response strings."""
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > maximum or any(not char.isprintable() for char in value):
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid response.')
    return value


def profile_text(value, maximum):
    """Bound untrusted profile text and remove control characters."""
    if not isinstance(value, str):
        return None
    return ''.join(char for char in value if char.isprintable())[:maximum]


def log_text(value):
    """Drop suspect log fields instead of exposing addresses or credentials."""
    if not isinstance(value, str) or len(value) > 300 or any(not char.isprintable() for char in value):
        return None
    if re.search(
        r'(?i)(?:\bbearer\s+\S+|\b(?:password|secret|token|api[_ -]?key)\s*[:=]\s*\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)',
        value,
    ):
        return None
    # Check IPv4 independently so a preceding colon cannot hide it inside an invalid IPv6 candidate.
    for part in re.findall(r'(?<![0-9])(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?![0-9])', value):
        try:
            ipaddress.IPv4Address(part)
        except ValueError:
            continue
        return None
    for part in re.findall(r'[0-9A-Fa-f:.]+', value):
        try:
            ipaddress.ip_address(part.strip('.'))
        except ValueError:
            continue
        return None
    return value


def user(value):
    """Select the user fields exposed to callers."""
    return {
        'user_id': bounded_text(value.get('user_id'), 300),
        'email': profile_text(value.get('email'), 254),
        'name': profile_text(value.get('name'), 300),
        'email_verified': value.get('email_verified') if isinstance(value.get('email_verified'), bool) else None,
    }


def event(value):
    """Select and sanitize authentication event fields."""
    event_type = log_text(value.get('type'))
    return {
        'log_id': log_text(value.get('log_id') or value.get('_id')),
        'date': log_text(value.get('date')),
        'type': event_type,
        'description': _EXPLANATIONS.get(event_type, _GENERIC),
        'connection': log_text(value.get('connection')),
        'client_name': log_text(value.get('client_name')),
    }


def blocks(response):
    """Select brute-force blocks and redact their identifiers."""
    data = object_response(response)
    # An unexpected response must not be mistaken for an unblocked account.
    if 'blocked_for' not in data:
        raise Auth0Error('API_ERROR', 'Auth0 returned an invalid block response.')
    entries = list_response(data['blocked_for'])
    return [
        {
            'identifier': '[REDACTED]' if item.get('identifier') is not None else None,
            'connection': log_text(item.get('connection')),
        }
        for item in entries
    ]
