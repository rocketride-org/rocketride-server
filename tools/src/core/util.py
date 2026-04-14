"""
util.py — shared utilities for the sync script.

NOTE: An equivalent is_retryable_error() implementation also lives inline in
ChatBase.is_retryable_error() (packages/ai/src/ai/common/chat.py). If you
update the classification logic here, keep the two in sync manually.
"""

from __future__ import annotations

import re


def is_retryable_error(error: Exception) -> bool:
    """
    Determine if an error is retryable based on common API and network error patterns.

    Checks for transient errors worth retrying: network timeouts, rate limits, and
    temporary server issues. Non-retryable errors include authentication failures,
    permission errors, and invalid requests.

    Args:
        error: The exception to evaluate

    Returns:
        True if the error is retryable, False otherwise
    """
    error_str = str(error).lower()
    error_type = type(error).__name__.lower()

    # Non-retryable patterns are checked FIRST so they can't be masked by a
    # retryable substring match (e.g. '500' inside a provider error code like
    # '1500' would otherwise trigger the retryable branch before reaching here).
    non_retryable_patterns = [
        'authentication',
        'unauthorized',
        'forbidden',
        'invalid api key',
        'permission denied',
        'access denied',
        'not found',
        'method not allowed',
        'bad request',
        'unprocessable entity',
        'invalid model',
        'invalid request',
    ]
    for pattern in non_retryable_patterns:
        if pattern in error_str:
            return False

    # Exact HTTP status code matches — use word-boundary-style check to avoid
    # false positives from provider-specific codes (e.g. '1500', '2429').
    non_retryable_codes = ['400', '401', '403', '404', '405', '422']
    retryable_codes = ['429', '500', '502', '503', '504']

    for code in non_retryable_codes:
        if re.search(rf'(?<!\d){code}(?!\d)', error_str):
            return False
    for code in retryable_codes:
        if re.search(rf'(?<!\d){code}(?!\d)', error_str):
            return True

    retryable_patterns = [
        'timeout',
        'timed out',
        'connection',
        'network',
        'socket',
        'connection reset',
        'connection refused',
        'connection aborted',
        'broken pipe',
        'network is unreachable',
        'rate limit',
        'rate_limit',
        'ratelimit',
        'too many requests',
        'quota exceeded',
        'throttled',
        'throttling',
        'internal server error',
        'bad gateway',
        'service unavailable',
        'gateway timeout',
        'server error',
        'temporary',
        'temporarily',
        'unavailable',
        'overloaded',
        'maintenance',
        'service degraded',
        'model overloaded',
        'capacity',
    ]
    retryable_types = [
        'timeouterror',
        'connectionerror',
        'httperror',
        'requestexception',
        'urlerror',
        'sslerror',
    ]

    for pattern in retryable_patterns:
        if pattern in error_str:
            return True
    if error_type in retryable_types:
        return True

    return False
