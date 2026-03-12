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
HTTP client for the Aparavi REST API.

Executes AQL queries via:
  POST /server/api/v3/database/query
    Body: {"select": "<aql>", "options": {"objectOffset": 0, "objectLimit": n}}
    Auth: HTTP Basic Auth (username + password)

Validates AQL via:
  GET /server/api/v3/database/query?select=<aql>&options={"validate":true}
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

import requests


class AqlClient:
    BASE_PATH = '/server/api/v3/database/query'
    DEFAULT_LIMIT = 250
    TIMEOUT = 30

    def __init__(self, *, url: str, user: str, password: str) -> None:
        self._base = url.rstrip('/')
        self._auth = (user, password)

    def execute(self, aql: str, limit: int = DEFAULT_LIMIT) -> Dict[str, Any]:
        """Execute an AQL query and return parsed results.

        Returns:
            {"rows": [...], "count": int, "columns": [...]}

        Raises:
            RuntimeError on HTTP error or non-JSON response.
        """
        try:
            resp = requests.post(
                self._base + self.BASE_PATH,
                auth=self._auth,
                json={
                    'select': aql,
                    'options': {'objectOffset': 0, 'objectLimit': limit},
                },
                timeout=self.TIMEOUT,
            )
            resp.raise_for_status()
            envelope = resp.json()
        except requests.HTTPError as exc:
            raise RuntimeError(f'Aparavi API HTTP error: {exc}') from exc
        except requests.RequestException as exc:
            raise RuntimeError(f'Aparavi API connection error: {exc}') from exc
        except (ValueError, KeyError) as exc:
            raise RuntimeError(f'Aparavi API returned unexpected response: {exc}') from exc

        if envelope.get('status') != 'OK':
            msg = envelope.get('message') or envelope.get('error') or envelope.get('status') or 'unknown error'
            raise RuntimeError(f'Aparavi API error: {msg}')

        data = envelope.get('data') or {}
        rows: List[Any] = data.get('objects') or []
        count: int = data.get('objectCount') or len(rows)
        columns: List[Any] = data.get('columns') or []

        rows = [self._normalize_row(row) for row in rows]
        return {'rows': rows, 'count': count, 'columns': columns}

    # Epoch values above this threshold are in milliseconds, not seconds.
    # 1e10 == year 2286 in seconds -- nothing Aparavi stores will legitimately
    # be that far in the future, so anything larger must be milliseconds.
    _MS_THRESHOLD = 10_000_000_000

    _DATE_FIELDS = {
        'createTime', 'modifyTime', 'accessTime',
        'docCreateTime', 'docModifyTime',
        'instanceMessageTime', 'objectMessageTime',
    }

    def _normalize_row(self, row: Any) -> Any:
        if not isinstance(row, dict):
            return row
        for field in self._DATE_FIELDS:
            val = row.get(field)
            if isinstance(val, (int, float)) and val > self._MS_THRESHOLD:
                row[field] = val / 1000
        return row

    def validate(self, aql: str) -> bool:
        """Validate an AQL query without executing it."""
        try:
            resp = requests.get(
                self._base + self.BASE_PATH,
                auth=self._auth,
                params={
                    'select': aql,
                    'options': json.dumps({'validate': True}),
                },
                timeout=self.TIMEOUT,
            )
            resp.raise_for_status()
            envelope = resp.json()
            if envelope.get('status') != 'OK':
                return False
            return bool((envelope.get('data') or {}).get('valid', False))
        except Exception:
            return False

