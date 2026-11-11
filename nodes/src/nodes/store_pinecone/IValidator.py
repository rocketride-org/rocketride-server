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

"""
Pinecone save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check validates the collection
name locally, then lists the account's indexes to confirm the key and that an
existing index matches the selected index type. The pinecone client is
imported inside the probe so this module stays import-light.
"""

import os
import re
from typing import Any, Mapping

from rocketlib import IValidatorBase, warning

from ai.common.config import warn_if_credential_unresolved

HTTP_BODY_MARKER = 'http response body:'


def _index_field(index: Any, name: str, default: Any = None) -> Any:
    """Read a field from an entry returned by ``list_indexes()``.

    The shape of those entries is not stable across the pinecone client. Older
    releases yielded plain dicts; from v7 the description objects (``IndexModel``)
    are returned instead, and they expose attributes but no ``.get()``. Calling
    ``.get()`` on one raises ``'IndexModel' object has no attribute 'get'``.

    requirements.txt pins no version, so which shape arrives depends on when the
    dependency was resolved.
    """
    if isinstance(index, dict):
        return index.get(name, default)
    value = getattr(index, name, None)
    if value is None:
        return default
    # Nested descriptions (``spec``) are themselves model objects; hand back a
    # mapping so callers can treat both shapes alike.
    if not isinstance(value, (str, int, float, bool, dict, list)):
        for converter in ('to_dict', 'model_dump', 'dict'):
            method = getattr(value, converter, None)
            if callable(method):
                try:
                    return method()
                except Exception:
                    continue
        return {
            key: getattr(value, key)
            for key in dir(value)
            if not key.startswith('_') and not callable(getattr(value, key, None))
        }
    return value


def _is_serverless(index: Any) -> bool:
    """Return True when an index description denotes a serverless index.

    The value has to be read, not just the key. ``IndexSpec.to_dict()`` emits
    every variant it knows about, unset ones included, so a pod-based index
    describes itself as ``{'serverless': None, 'pod': {...}, 'byoc': None}``.
    Testing for key membership therefore reports every pod-based index as
    serverless and produces the opposite compatibility warning to the one the
    user needs.
    """
    spec = _index_field(index, 'spec', {}) or {}
    if isinstance(spec, dict):
        return bool(spec.get('serverless'))
    return bool(getattr(spec, 'serverless', None))


def probe_connection(config: Mapping) -> None:
    """
    Validate the configuration for the Pinecone vector store.

    Collection name rules per the Pinecone docs, then the key and index-type
    compatibility through ``list_indexes()``. Reports problems with
    ``warning()`` and never raises: the user is still editing the node.

    Args:
        config: The resolved node config (apikey, collection, profile).
    """
    try:
        apikey = config['apikey']
        collection = config['collection']
        profile = config['profile']  # pod-based or serverless-dense

        # Step 1: collection name validation; every violation is reported together
        violations: list[str] = []
        if not collection:
            violations.append('is missing')
        else:
            if not re.match(r'^[a-z0-9-]+$', collection):
                violations.append('must use only lowercase letters, numbers, and hyphens')
            if collection.startswith('-') or collection.endswith('-'):
                violations.append('cannot start or end with a hyphen')
            if '--' in collection:
                violations.append("cannot contain consecutive hyphens ('--')")
            if len(collection) > 45:
                violations.append('is too long (max 45 characters)')
        if violations:
            warning(f"Collection name '{collection or '<empty>'}' is invalid: " + '; '.join(violations))
            return

        # Step 2: key and index-type check
        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from pinecone import Pinecone

        client = Pinecone(api_key=apikey)
        index_list = client.list_indexes()

        existing = next((index for index in index_list if _index_field(index, 'name') == collection), None)
        if existing:
            serverless = _is_serverless(existing)
            if profile == 'serverless-dense' and not serverless:
                warning(
                    f"Collection '{collection}' exists and is pod-based but you selected serverless mode. "
                    "Please select 'Pinecone Pod-Based Index' to use this collection"
                )
                return
            if profile == 'pod-based' and serverless:
                warning(
                    f"Collection '{collection}' exists and is serverless but you selected pod-based mode. "
                    "Please select 'Pinecone Serverless Dense Index' to use this collection"
                )
                return

    except Exception as e:
        warning(_format_error(e))


def _format_error(e: Exception) -> str:
    """Return a concise error string, preferring the SDK's structured status and body."""
    try:
        # exception is optional, ignore it by contract-check if not present
        from pinecone.core.client.exceptions import ApiException as _ApiException  # type: ignore  # contract-check: ignore

        if isinstance(e, _ApiException):
            status = getattr(e, 'status', None)
            body = (getattr(e, 'body', '') or getattr(e, 'reason', '') or str(e)).strip()
            return f'Error {status}: {body}' if status else body
    except Exception:
        pass

    status = getattr(e, 'status', None)
    body_attr = getattr(e, 'body', None) or getattr(e, 'reason', None)
    if status is not None or body_attr:
        body = (body_attr or str(e)).strip()
        return f'Error {status}: {body}' if status else body

    # Fallback: extract after HTTP_BODY_MARKER
    error_str = str(e)
    idx = error_str.lower().find(HTTP_BODY_MARKER)
    if idx != -1:
        return error_str[idx + len(HTTP_BODY_MARKER) :].strip()
    return error_str.strip()


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the connectivity probe."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, probe the account.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        # An unfilled reference is reported as such; the probe must not send the placeholder as the key
        if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', config['apikey']):
            return
        probe_connection(config)
