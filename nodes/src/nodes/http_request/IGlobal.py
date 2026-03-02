# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
HTTP Request tool node - global (shared) state.

Reads the node configuration and creates an ``HttpDriver`` that exposes a
single ``http_request`` tool for agent invocation.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .http_driver import HttpDriver


class IGlobal(IGlobalBase):
    """Global state for http_request."""

    driver: HttpDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        server_name = str((cfg.get('serverName') or 'http')).strip()

        defaults = self._build_defaults(cfg)

        try:
            self.driver = HttpDriver(server_name=server_name, defaults=defaults)
        except Exception as e:
            warning(str(e))
            raise

    @staticmethod
    def _array_to_dict(rows: list, key_field: str, value_field: str) -> dict:
        """Convert an array-of-objects from the UI into a flat dict.

        The UI stores key-value pairs as ``[{key_field: k, value_field: v}, ...]``.
        The driver expects a plain ``{k: v, ...}`` dict.
        """
        result: dict = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            k = str(row.get(key_field) or '').strip()
            if k:
                result[k] = str(row.get(value_field) or '')
        return result

    @staticmethod
    def _build_defaults(cfg: dict) -> dict:
        """Extract user-configured defaults from the node config panel."""
        defaults: dict = {}

        method = str(cfg.get('method') or '').strip().upper()
        if method:
            defaults['method'] = method

        url = str(cfg.get('url') or '').strip()
        if url:
            defaults['url'] = url

        auth_type = str(cfg.get('authType') or 'none').strip().lower()
        if auth_type and auth_type != 'none':
            auth: dict = {'type': auth_type}
            if auth_type == 'basic':
                auth['basic'] = {
                    'username': str(cfg.get('username') or ''),
                    'password': str(cfg.get('password') or ''),
                }
            elif auth_type == 'bearer':
                auth['bearer'] = {
                    'token': str(cfg.get('bearerToken') or ''),
                }
            elif auth_type == 'api_key':
                auth['api_key'] = {
                    'key': str(cfg.get('apiKeyName') or 'X-API-Key'),
                    'value': str(cfg.get('apiKeyValue') or ''),
                    'add_to': str(cfg.get('apiKeyAddTo') or 'header'),
                }
            defaults['auth'] = auth

        body_type = str(cfg.get('bodyType') or 'none').strip().lower()
        if body_type and body_type != 'none':
            body: dict = {'type': body_type}
            if body_type == 'raw':
                body['raw'] = {
                    'content': str(cfg.get('rawContent') or ''),
                    'content_type': str(cfg.get('rawContentType') or 'application/json'),
                }
            elif body_type == 'form_data':
                raw_fd = cfg.get('bodyFormData') or []
                body['form_data'] = (
                    IGlobal._array_to_dict(raw_fd, 'formDataKey', 'formDataValue')
                    if isinstance(raw_fd, list) else raw_fd
                )
            elif body_type == 'x_www_form_urlencoded':
                raw_ue = cfg.get('bodyUrlencoded') or []
                body['urlencoded'] = (
                    IGlobal._array_to_dict(raw_ue, 'urlencodedKey', 'urlencodedValue')
                    if isinstance(raw_ue, list) else raw_ue
                )
            defaults['body'] = body

        raw_headers = cfg.get('headers') or []
        if isinstance(raw_headers, list) and raw_headers:
            defaults['headers'] = IGlobal._array_to_dict(
                raw_headers, 'headerKey', 'headerValue'
            )
        elif isinstance(raw_headers, dict) and raw_headers:
            defaults['headers'] = raw_headers

        raw_qp = cfg.get('queryParams') or []
        if isinstance(raw_qp, list) and raw_qp:
            defaults['query_params'] = IGlobal._array_to_dict(
                raw_qp, 'queryKey', 'queryValue'
            )
        elif isinstance(raw_qp, dict) and raw_qp:
            defaults['query_params'] = raw_qp

        raw_pp = cfg.get('pathParams') or []
        if isinstance(raw_pp, list) and raw_pp:
            defaults['path_params'] = IGlobal._array_to_dict(
                raw_pp, 'pathKey', 'pathValue'
            )
        elif isinstance(raw_pp, dict) and raw_pp:
            defaults['path_params'] = raw_pp

        return defaults

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            server_name = str((cfg.get('serverName') or '')).strip()
            if not server_name:
                warning('serverName is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.driver = None
