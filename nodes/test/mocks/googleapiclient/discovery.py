# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Mock googleapiclient.discovery for tool_gmail testing.

When ROCKETRIDE_MOCK is set, this replaces the real discovery client so the
Gmail node builds a stub service that returns canned responses instead of
calling Google. The chain mirrors the real API:

    build('gmail', 'v1', credentials=...).users().messages().get(...).execute()
"""

_RESOURCES = {'users', 'messages', 'threads', 'labels', 'drafts', 'history', 'attachments'}

_CANNED = {
    'list': {'messages': [{'id': 'mock1', 'threadId': 'mockt'}], 'resultSizeEstimate': 1, 'historyId': '1'},
    'get': {
        'id': 'mock1',
        'threadId': 'mockt',
        'labelIds': ['INBOX'],
        'snippet': 'Mock message body',
        'historyId': '1',
        'payload': {'headers': [{'name': 'Subject', 'value': 'Mock'}, {'name': 'From', 'value': 'mock@example.com'}]},
        'messages': [{'id': 'mock1', 'threadId': 'mockt', 'payload': {'headers': []}}],
    },
    'send': {'id': 'mocksent', 'threadId': 'mockt', 'labelIds': ['SENT']},
    'modify': {'id': 'mock1', 'threadId': 'mockt', 'labelIds': ['INBOX']},
    'batchModify': {},
    'batchDelete': {},
    'trash': {'id': 'mock1', 'labelIds': ['TRASH']},
    'untrash': {'id': 'mock1', 'labelIds': ['INBOX']},
    'delete': {},
    'create': {'id': 'mockcreated', 'name': 'Mock', 'message': {'id': 'mock1', 'threadId': 'mockt'}},
    'update': {'id': 'mockcreated', 'message': {'id': 'mock1', 'threadId': 'mockt'}},
}


class _Request:
    def __init__(self, result):
        self._result = result

    def execute(self):
        return self._result


class _Node:
    def __init__(self, path):
        self._path = path

    def __getattr__(self, name):
        def method(**kwargs):
            if name in _RESOURCES:
                return _Node(f'{self._path}.{name}')
            if name == 'list' and self._path.endswith('labels'):
                return _Request({'labels': [{'id': 'INBOX', 'name': 'INBOX', 'type': 'system'}]})
            if name == 'list' and self._path.endswith('threads'):
                return _Request({'threads': [{'id': 'mockt', 'historyId': '1', 'snippet': 'Mock'}]})
            if name == 'list' and self._path.endswith('drafts'):
                return _Request({'drafts': [{'id': 'mockd', 'message': {'id': 'mock1', 'threadId': 'mockt'}}]})
            if name == 'get' and self._path.endswith('attachments'):
                return _Request({'attachmentId': 'mocka', 'size': 3, 'data': 'bW9j'})
            return _Request(_CANNED.get(name, {}))

        return method


class _Service:
    def users(self):
        return _Node('users')


def build(serviceName, version, credentials=None, cache_discovery=True, **kwargs):
    return _Service()
