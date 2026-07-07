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
HTTP client for the HydraDB v2 REST API (https://api.hydradb.com).

A thin wrapper the node's IInstance calls. Uses the shared ``post_with_retry``
helper so retry/backoff behavior matches the rest of the catalog. No vendor SDK:
we target the v2 REST endpoints directly to avoid the SDK's v1/v2 (tenant vs
database) API drift. v2 scopes data by ``database`` + ``collection`` (the older
``tenant_id`` / ``sub_tenant_id`` names remain accepted as deprecated aliases).

This module is engine-free (only stdlib + the shared HTTP helper) so it is
unit-testable without the runtime.
"""

from __future__ import annotations

import json as _json
import os
from typing import Any, Dict, List, Optional

import requests

from ai.common.utils import post_with_retry

DEFAULT_BASE_URL = 'https://api.hydradb.com'


class HydraDBError(RuntimeError):
    """Raised when the HydraDB API call fails (transport error or non-2xx response)."""


class HydraDBClient:
    """Minimal HydraDB v2 REST client for the store/recall operations."""

    def __init__(
        self,
        api_key: str,
        database: str,
        *,
        collection: str = 'default',
        base_url: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.api_key = api_key
        self.database = database
        self.collection = collection or 'default'
        self.base_url = (base_url or os.environ.get('HYDRA_DB_BASE_URL') or DEFAULT_BASE_URL).rstrip('/')
        self.timeout = timeout

    def _headers(self) -> Dict[str, str]:
        # Bearer auth; never logged.
        return {'Authorization': f'Bearer {self.api_key}', 'Content-Type': 'application/json'}

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        url = f'{self.base_url}{path}'
        try:
            resp = post_with_retry(url, headers=self._headers(), json=body, timeout=self.timeout)
        except Exception as e:  # transport error or exhausted retries (HTTPError on final 4xx/5xx)
            # Do not include headers/body in the message so the API key never leaks.
            raise HydraDBError(f'HydraDB request to {path} failed: {e}') from e
        try:
            return resp.json()
        except ValueError:
            return {}

    def store_memory(
        self,
        text: str,
        *,
        metadata: Optional[Dict[str, Any]] = None,
        collection: Optional[str] = None,
        infer: bool = True,
        upsert: bool = True,
    ) -> Dict[str, Any]:
        """Ingest ``text`` as a memory (POST /context/ingest, type=memory).

        ``infer=True`` triggers HydraDB's knowledge-graph extraction; ``upsert=True``
        replaces an existing memory with the same content. The ``memories`` payload is
        JSON-encoded to match HydraDB's documented ingest shape.
        """
        memory: Dict[str, Any] = {'text': text}
        if metadata:
            memory['metadata'] = metadata
        body: Dict[str, Any] = {
            'type': 'memory',
            'database': self.database,
            'collection': collection or self.collection,
            'memories': _json.dumps([memory]),
            'infer': infer,
            'upsert': upsert,
        }
        return self._post('/context/ingest', body)

    def query(
        self,
        query: str,
        *,
        type: str = 'all',
        max_results: int = 10,
        collection: Optional[str] = None,
        query_by: str = 'hybrid',
        mode: str = 'fast',
        graph_context: bool = True,
    ) -> Dict[str, Any]:
        """Unified retrieval (POST /query). ``type`` is one of knowledge | memory | all."""
        body: Dict[str, Any] = {
            'database': self.database,
            'query': query,
            'type': type,
            'query_by': query_by,
            'mode': mode,
            'max_results': max_results,
            'graph_context': graph_context,
        }
        col = collection or self.collection
        if col:
            body['collection'] = col
        return self._post('/query', body)

    def _get(self, path: str, params: Dict[str, Any]) -> Dict[str, Any]:
        url = f'{self.base_url}{path}'
        try:
            resp = requests.get(url, headers=self._headers(), params=params, timeout=self.timeout)
            resp.raise_for_status()
        except Exception as e:  # transport error or non-2xx response
            # Do not include headers in the message so the API key never leaks.
            raise HydraDBError(f'HydraDB request to {path} failed: {e}') from e
        try:
            return resp.json()
        except ValueError:
            return {}

    def relations(self, *, source_id: Optional[str] = None, collection: Optional[str] = None) -> Dict[str, Any]:
        """Inspect entity/relationship triplets (GET /context/relations).

        Pass ``source_id`` to scope to a single ingested item; omit it to return all
        relations in the collection.
        """
        params: Dict[str, Any] = {'database': self.database}
        if source_id:
            params['id'] = source_id
        col = collection or self.collection
        if col:
            params['collection'] = col
        return self._get('/context/relations', params)

    def collections(self) -> Dict[str, Any]:
        """List collection ids in the database (GET /databases/collections)."""
        return self._get('/databases/collections', {'database': self.database})

    def status(self) -> Dict[str, Any]:
        """Database infrastructure readiness (GET /databases/status)."""
        return self._get('/databases/status', {'database': self.database})

    @staticmethod
    def unwrap(response: Any) -> Dict[str, Any]:
        """Unwrap HydraDB's ``{"data": {...}}`` envelope; returns {} for non-dicts."""
        if not isinstance(response, dict):
            return {}
        data = response.get('data')
        return data if isinstance(data, dict) else response

    @staticmethod
    def extract_results(response: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Best-effort extraction of the ranked result list from a /query response."""
        if not isinstance(response, dict):
            return []
        for key in ('chunks', 'results', 'data'):
            value = response.get(key)
            if isinstance(value, list):
                return value
        return []
