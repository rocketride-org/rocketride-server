# =============================================================================
# MIT License
#
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
Resolved-schema fixtures in the shape the engine emits (plan §5.6.1 / §5.1).

Every leaf carries a dotted ``path``; a selector is an enum keyed by value whose
branches resolve at the selector's own level; a leaf referenced by the identical
specifier in every branch is hoisted (its ``path`` is the parent's, and it is
still emitted inside each branch); ``params`` is the flat list of
self-contained descriptors for the ``param``-flagged leaves; ``capabilities`` is
the PROTOCOL_CAPS int bitmask.
"""

from __future__ import annotations

import copy
from typing import Any, Dict

#: PROTOCOL_CAPS bits as the engine emits them in the resolved schema (apLib/url/Url.hpp).
CAP_NETWORK = 1 << 3
CAP_INVOKE = 1 << 10
CAP_GPU = 1 << 12
CAP_MULTITENANT = 1 << 17


def _leaf(name: str, path: str, **members: Any) -> Dict[str, Any]:
    """Build one leaf descriptor."""
    return {'name': name, 'path': path, **members}


# ==== Google Workspace: selector + hoisted leaf ==============================

#: `access` is referenced by the identical specifier in both branches, so the
#: engine hoists it to the root path and still emits it inside each branch.
_ACCESS = _leaf(
    'access',
    'access',
    type='string',
    title='Access',
    default='readonly',
    enum=[['readonly', 'Read only'], ['readwrite', 'Read and write']],
)

GOOGLE_WORKSPACE: Dict[str, Any] = {
    'title': 'Google Workspace',
    'protocol': 'tool_google_workspace://',
    'capabilities': CAP_INVOKE,
    'properties': [
        _leaf('type', 'type', type='constant', default='tool_google_workspace'),
        {
            'name': 'authType',
            'path': 'authType',
            'type': 'string',
            'title': 'Authentication',
            'default': 'service',
            'enum': {
                'service': {
                    'title': 'Service account',
                    'properties': [
                        _leaf(
                            'customerId',
                            'service.customerId',
                            type='string',
                            title='Customer id',
                            default='my_customer',
                        ),
                        _leaf('adminEmail', 'service.adminEmail', type='string', title='Admin email', required=True),
                        _leaf('serviceKey', 'service.serviceKey', type='string', title='Service key', secret=True),
                        _ACCESS,
                    ],
                },
                'user': {
                    'title': 'User sign-in',
                    'properties': [
                        _leaf('userAuth', 'user.userAuth', type='oauth2', title='Google account'),
                        _ACCESS,
                    ],
                },
            },
        },
    ],
    'params': [],
}


# ==== Qdrant-like: nested selector, branch-specific leaves ===================

QDRANT: Dict[str, Any] = {
    'title': 'Qdrant',
    'protocol': 'store_qdrant://',
    'capabilities': CAP_NETWORK,
    'properties': [
        _leaf('type', 'type', type='constant', default='store_qdrant'),
        {
            'name': 'mode',
            'path': 'mode',
            'type': 'string',
            'default': 'cloud',
            'enum': {
                'cloud': {
                    'properties': [
                        _leaf('host', 'cloud.host', type='string', default='https://cloud.qdrant.io'),
                        {
                            'name': 'auth',
                            'path': 'cloud.auth',
                            'type': 'string',
                            'default': 'apikey',
                            'enum': {
                                'apikey': {
                                    'properties': [_leaf('key', 'cloud.apikey.key', type='string', minLength=4)]
                                },
                                'token': {'properties': [_leaf('token', 'cloud.token.token', type='string')]},
                            },
                        },
                    ],
                },
                'local': {
                    'properties': [
                        _leaf('host', 'local.host', type='string', default='localhost'),
                        _leaf('port', 'local.port', type='integer', default=6333, minimum=1, maximum=65535),
                    ],
                },
            },
        },
        _leaf('score', 'score', type='number', default=0.7, minimum=0, maximum=1),
        _leaf('collection', 'collection', type='string', default='documents'),
    ],
    'params': [],
}


# ==== Depth estimate: a param, an env-valued key, a group ====================

DEPTH_ESTIMATE: Dict[str, Any] = {
    'title': 'Depth estimate',
    'protocol': 'depth_estimate://',
    'capabilities': CAP_GPU,
    'properties': [
        _leaf('type', 'type', type='constant', default='depth_estimate'),
        _leaf('model', 'model', type='string', default='depth-anything-v2'),
        _leaf('revision', 'revision', type='string', default='main'),
        _leaf('maxEdge', 'maxEdge', type='integer', default=640, minimum=64, maximum=4096, param=True),
        _leaf('apikey', 'apikey', type='string', default='${ROCKETRIDE_DEPTH_APIKEY}'),
        {
            'name': 'tuning',
            'properties': [
                _leaf('threads', 'tuning.threads', type='integer', default=2, minimum=1),
                _leaf('tags', 'tuning.tags', type='array', default=[], items={'type': 'string'}),
            ],
        },
    ],
    'params': [
        {
            'field': 'maxEdge',
            'type': 'integer',
            'title': 'Max edge',
            'description': 'Longest image side fed to the model.',
            'minimum': 64,
            'maximum': 4096,
            'default': 640,
        }
    ],
}


def multitenant(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of ``schema`` certified ``multitenant``."""
    certified = copy.deepcopy(schema)
    certified['capabilities'] = int(certified.get('capabilities', 0)) | CAP_MULTITENANT
    return certified
