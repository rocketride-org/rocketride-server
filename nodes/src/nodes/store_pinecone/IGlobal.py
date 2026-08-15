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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------

import os
import re
from typing import Any, Dict

from ai.common.store import StoreGlobalBase
from rocketlib import warning

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
        return {key: getattr(value, key) for key in dir(value) if not key.startswith('_')}
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


class IGlobal(StoreGlobalBase):
    serverName: str = 'pinecone'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .pinecone import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: host/port/collection."""
        return f'{self.store.host}/{self.store.port}/{self.store.collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Validate the configuration for Pinecone vector store.

        Comprehensive validation: API key, collection name, index existence, compatibility.
        """
        try:
            # Load dependencies first
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Import pinecone after dependencies are loaded
            # Use HTTP client for validation to surface structured ApiException with status/body
            from pinecone import Pinecone

            apikey = config.get('apikey')
            collection = config.get('collection')
            mode = config.get('mode')  # pod-based or serverless-dense

            # Step 1: Collection Name Validation (per Pinecone docs)
            # Gather all violations and report them together to the user
            violations: list[str] = []

            # Normalize and guard
            if not collection:
                violations.append('is missing')
            else:
                # Check collection name format (lowercase, alphanumeric, hyphens only)
                if not re.match(r'^[a-z0-9-]+$', collection):
                    violations.append('must use only lowercase letters, numbers, and hyphens')

                # Check for leading/trailing hyphens
                if collection.startswith('-') or collection.endswith('-'):
                    violations.append('cannot start or end with a hyphen')

                # Check for consecutive hyphens
                if '--' in collection:
                    violations.append("cannot contain consecutive hyphens ('--')")

                # Check collection name length (Pinecone limit)
                if len(collection) > 45:
                    violations.append('is too long (max 45 characters)')

            if violations:
                name = collection or '<empty>'
                warning(f"Collection name '{name}' is invalid: " + '; '.join(violations))
                return

            # Step 2: API Authentication and Collection Check
            # Initialize client and list indexes
            client = Pinecone(api_key=apikey)
            index_list = client.list_indexes()

            # Check if collection exists and validate mode compatibility
            existing_collection = next(
                (index for index in index_list if _index_field(index, 'name') == collection), None
            )
            if existing_collection:
                is_serverless = _is_serverless(existing_collection)
                if mode == 'serverless-dense' and not is_serverless:
                    warning(
                        f"Collection '{collection}' exists and is pod-based but you selected serverless mode. Please select 'Pinecone Pod-Based Index' to use this collection"
                    )
                    return
                if mode == 'pod-based' and is_serverless:
                    warning(
                        f"Collection '{collection}' exists and is serverless but you selected pod-based mode. Please select 'Pinecone Serverless Dense Index' to use this collection"
                    )
                    return

        except Exception as e:
            # Prefer SDK/HTTP structured attributes if available
            try:
                # exception is optional, ignore it by contract-check if not present
                from pinecone.core.client.exceptions import ApiException as _ApiException  # type: ignore  # contract-check: ignore

                if isinstance(e, _ApiException):
                    status = getattr(e, 'status', None)
                    body = getattr(e, 'body', '') or getattr(e, 'reason', '') or str(e)
                    body = body.strip()
                    message = f'Error {status}: {body}' if status else body
                    warning(message)
                    return
            except Exception:
                pass

            status = getattr(e, 'status', None)
            body_attr = getattr(e, 'body', None) or getattr(e, 'reason', None)
            if status is not None or body_attr:
                body = (body_attr or str(e)).strip()
                message = f'Error {status}: {body}' if status else body
                warning(message)
                return

            # Fallback: extract after HTTP_BODY_MARKER
            error_str = str(e)
            lower = error_str.lower()
            idx = lower.find(HTTP_BODY_MARKER)
            if idx != -1:
                body = error_str[idx + len(HTTP_BODY_MARKER) :].strip()
                warning(body)
            else:
                warning(error_str.strip())
            return
