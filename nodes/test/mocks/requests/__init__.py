"""
Mock requests package for search_exa node testing.

When ROCKETRIDE_MOCK is set, this replaces the real requests package inside
pipeline subprocesses. The mock is intentionally narrow: it only implements the
POST call shape used by search_exa against Exa's search endpoint.
"""

from __future__ import annotations


class Response:
    def __init__(self, status_code: int, payload: dict):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)

    def json(self):
        return self._payload


def post(url, headers=None, json=None, timeout=None):
    if url != 'https://api.exa.ai/search':
        raise RuntimeError(f'Unhandled mock requests.post URL: {url}')
    if not isinstance(headers, dict):
        raise RuntimeError('Expected Exa request headers dict')
    if headers.get('x-api-key') != 'exa-mock-placeholder-for-tests':
        raise RuntimeError('Expected Exa mock API key header')
    if headers.get('Content-Type') != 'application/json':
        raise RuntimeError('Expected Exa JSON content type header')
    if timeout != 30:
        raise RuntimeError(f'Expected Exa timeout=30, got {timeout!r}')

    query = ''
    search_type = 'auto'
    if isinstance(json, dict):
        query = str(json.get('query') or '')
        search_type = str(json.get('type') or 'auto')

    payload = {
        'requestId': 'mock-exa-request-id',
        'results': [
            {
                'id': 'https://exa.ai/docs/reference/search-api-guide',
                'title': 'Exa Search API',
                'url': 'https://exa.ai/docs/reference/search-api-guide',
                'highlights': [f'Mock Exa result for query: {query}'],
            }
        ],
        'searchTime': 1.23,
        'resolvedSearchType': search_type,
        'costDollars': {
            'total': 0.0,
            'search': {
                search_type: 0.0,
            },
        },
    }
    return Response(200, payload)
