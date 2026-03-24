# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

from __future__ import annotations

import json
from typing import Any, Dict, List

import requests

from ai.common.chat import ChatBase
from ai.common.config import Config
from ai.common.schema import Answer, Question

_EXA_SEARCH_URL = 'https://api.exa.ai/search'


def _get_question_texts(question: Question) -> List[str]:
    texts: List[str] = []
    if hasattr(question, 'questions'):
        qs = getattr(question, 'questions') or []
        for item in qs:
            text = getattr(item, 'text', None) or str(item)
            text = str(text).strip()
            if text:
                texts.append(text)
    elif hasattr(question, 'text'):
        text = getattr(question, 'text', None)
        if text:
            texts.append(str(text).strip())
    return texts


class ExaSearch(ChatBase):
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
        self._include_highlights = bool(config.get('includeHighlights', True))
        self._highlight_chars = int(config.get('highlightChars') or 600)
        bag['search_exa'] = self

    def getTokens(self, value: str) -> int:
        return max(1, int(len(str(value).split()) / 0.75))

    def chat(self, question: Question) -> Answer:
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

        response = requests.post(
            _EXA_SEARCH_URL,
            headers={
                'x-api-key': self._apikey,
                'Content-Type': 'application/json',
            },
            json=payload,
            timeout=30,
        )

        if response.status_code >= 400:
            raise self._map_error(response)

        body = response.json()
        answer = Answer(expectJson=question.expectJson)
        answer.setAnswer(json.dumps(body, indent=2))
        return answer

    def _map_error(self, response: requests.Response) -> Exception:
        try:
            payload = response.json()
        except Exception:
            payload = {}

        message = payload.get('error') or payload.get('message') or response.text
        if response.status_code == 401:
            return ValueError(f'Exa authentication failed: {message}')
        if response.status_code == 429:
            return ValueError(f'Exa rate limit exceeded: {message}')
        return ValueError(f'Exa request failed ({response.status_code}): {message}')
