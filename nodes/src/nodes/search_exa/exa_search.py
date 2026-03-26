# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from __future__ import annotations

import ipaddress
import json
import os
import socket
from typing import Any, Dict, List
from urllib.parse import urlparse

import requests

from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.schema import Answer, Question

_EXA_SEARCH_URL = 'https://api.exa.ai/search'
_URL_FIELDS = {'url', 'image', 'favicon'}


def _get_question_texts(question: Question) -> List[str]:
    """Extract normalized text queries from a RocketRide question payload."""
    texts: List[str] = []
    if hasattr(question, 'questions'):
        qs = getattr(question, 'questions') or []
        for item in qs:
            text = getattr(item, 'text', None) or str(item)
            text = str(text).strip()
            if text:
                texts.append(text)
    if not texts and hasattr(question, 'text'):
        text = str(getattr(question, 'text', None) or '').strip()
        if text:
            texts.append(text)
    return texts


def _get_bool(value: Any, default: bool) -> bool:  # noqa: ANN401
    """Parse booleans defensively, including common string representations."""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {'true', '1', 'yes', 'on'}:
            return True
        if normalized in {'false', '0', 'no', 'off'}:
            return False
    return bool(value)


class ExaSearch(ChatBase):
    """Search backend that sends a single user query to Exa and returns raw JSON."""

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        super().__init__(provider, connConfig, bag)
        config = Config.getNodeConfig(provider, connConfig)
        self._apikey = str(
            config.get('apikey')
            or connConfig.get('apikey')
            or os.environ.get('ROCKETRIDE_APIKEY_EXA')
            or ''
        ).strip()
        self._search_type = str(config.get('type') or 'auto').strip() or 'auto'
        self._num_results = int(config.get('numResults') or 5)
        self._include_highlights = _get_bool(config.get('includeHighlights'), True)
        self._highlight_chars = int(config.get('highlightChars') or 600)
        bag['search_exa'] = self

    def getTokens(self, value: str) -> int:
        """Estimate token usage for the given text using a word-based heuristic."""
        return max(1, int(len(str(value).split()) / 0.75))

    def chat(self, question: Question) -> Answer:
        """Execute one Exa search request and return the raw result payload as an answer."""
        queries = _get_question_texts(question)
        if not queries:
            raise ValueError('search_exa requires a non-empty question')
        if len(queries) > 1:
            raise ValueError('search_exa expects exactly one question')
        query = queries[0]

        payload: Dict[str, Any] = {
            'query': query,
            'type': self._search_type,
            'numResults': self._num_results,
        }
        if self._include_highlights:
            payload['contents'] = {
                'highlights': {
                    'maxCharacters': self._highlight_chars,
                }
            }

        try:
            response = requests.post(
                _EXA_SEARCH_URL,
                headers={
                    'x-api-key': self._apikey,
                    'Content-Type': 'application/json',
                },
                json=payload,
                timeout=30,
            )
        except requests.Timeout as e:
            raise TimeoutError('Exa request timed out') from e
        except requests.ConnectionError as e:
            raise ConnectionError('Unable to connect to Exa') from e
        except requests.RequestException as e:
            raise RuntimeError(f'Exa request failed: {e}') from e

        if response.status_code >= 400:
            raise self._map_error(response)

        body = response.json()
        body = self._sanitize_result_urls(body)
        answer = Answer(expectJson=question.expectJson)
        answer.setAnswer(json.dumps(body, indent=2))
        return answer

    def _sanitize_result_urls(self, value: Any) -> Any:  # noqa: ANN401
        if os.environ.get('ROCKETRIDE_MOCK'):
            return value

        if isinstance(value, list):
            sanitized_items = []
            for item in value:
                sanitized_item = self._sanitize_result_urls(item)
                if sanitized_item is not None:
                    sanitized_items.append(sanitized_item)
            return sanitized_items

        if isinstance(value, dict):
            sanitized: Dict[str, Any] = {}
            for key, item in value.items():
                if key in _URL_FIELDS and isinstance(item, str):
                    try:
                        sanitized[key] = self._validate_public_url(item)
                    except ValueError:
                        if key == 'url':
                            return None
                        continue
                else:
                    sanitized[key] = self._sanitize_result_urls(item)
            return sanitized

        return value

    def _validate_public_url(self, raw_url: str) -> str:
        parsed = urlparse(raw_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise ValueError(f'Exa returned an invalid URL: {raw_url}')

        try:
            addrinfo = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
        except socket.gaierror as e:
            raise ValueError(f'Exa returned an unresolved URL host: {parsed.hostname}') from e

        for _, _, _, _, sockaddr in addrinfo:
            ip = ipaddress.ip_address(sockaddr[0])
            if (
                ip.is_private
                or ip.is_loopback
                or ip.is_link_local
                or ip.is_reserved
                or ip.is_multicast
                or ip.is_unspecified
            ):
                raise ValueError(f'Exa returned a blocked URL host: {parsed.hostname}')

        return raw_url

    def _map_error(self, response: requests.Response) -> Exception:
        try:
            payload = response.json()
        except Exception:
            payload = {}

        message = payload.get('error') or payload.get('message') or response.text
        if response.status_code == 401:
            return PermissionError(f'Exa authentication failed: {message}')
        if response.status_code == 429:
            return RuntimeError(f'Exa rate limit exceeded: {message}')
        return RuntimeError(f'Exa request failed ({response.status_code}): {message}')
