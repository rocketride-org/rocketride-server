# Copyright 2026 Aparavi Software AG. MIT License.
"""Managed SaaS evaluation operations for existing RocketRide agent harnesses."""

import json
import re
from urllib.parse import urlsplit, urlunsplit

import httpx

from ..errors import _bad
from ..identity import CALLER_AUTH
from ..tooling import ToolRegistry

# A closed operation catalog, not a model-controlled URL/method proxy. The SaaS
# service is the authority for tenant isolation and the versioned EvalSpec.
_OPERATIONS = {
    'capabilities': ('GET', '/capabilities', (), ()),
    'list': ('GET', '/evaluations', (), ('projectId',)),
    'get': ('GET', '/evaluations/{evaluationId}', ('evaluationId',), ()),
    'create': ('POST', '/evaluations', ('spec',), ()),
    'revise': ('POST', '/evaluations/{evaluationId}/revisions', ('evaluationId', 'spec', 'expectedRevision'), ()),
    'run': (
        'POST',
        '/evaluations/{evaluationId}/runs',
        ('evaluationId', 'revision', 'idempotencyKey'),
        ('baselineRunId',),
    ),
    'runs': ('GET', '/runs', ('evaluationId',), ()),
    'status': ('GET', '/runs/{runId}', ('runId',), ()),
    'cancel': ('POST', '/runs/{runId}/cancel', ('runId',), ()),
    'baseline': ('POST', '/evaluations/{evaluationId}/baseline', ('evaluationId', 'runId'), ()),
    'report': ('GET', '/runs/{runId}/report', ('runId',), ('format',)),
    'review': ('POST', '/runs/{runId}/review', ('runId', 'review'), ()),
    'assist': ('POST', '/assistant', ('instruction', 'spec'), ()),
}
_ID = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def _request_args(args: dict):
    operation = args.get('operation')
    if not isinstance(operation, str) or operation not in _OPERATIONS:
        raise ValueError('operation must be one of: ' + ', '.join(_OPERATIONS))
    method, path, required, optional = _OPERATIONS[operation]
    if set(args) - {'operation', *required, *optional}:
        raise ValueError('Unexpected arguments for ' + operation)
    if any(key not in args for key in required):
        raise ValueError('Required arguments: ' + ', '.join(required))
    for key, value in args.items():
        if key in ('evaluationId', 'runId', 'baselineRunId', 'projectId'):
            if not isinstance(value, str) or not _ID.fullmatch(value):
                raise ValueError(key + ' must be a resource identifier')
        elif key in ('revision', 'expectedRevision'):
            if type(value) is not int or value < 1:
                raise ValueError(key + ' must be a positive integer')
        elif key in ('spec', 'review'):
            if not isinstance(value, dict):
                raise ValueError(key + ' must be an object')
        elif key in ('idempotencyKey', 'instruction'):
            if (
                not isinstance(value, str)
                or not value.strip()
                or len(value) > (128 if key == 'idempotencyKey' else 16000)
            ):
                raise ValueError(key + ' must be a nonempty, bounded string')
        elif key == 'format' and value not in ('json', 'junit'):
            raise ValueError('format must be json or junit')
    # Substitutions are validated identifiers. Never accept arbitrary paths,
    # headers, methods, host overrides, or query fragments from a model.
    body = {key: value for key, value in args.items() if key != 'operation' and '{' + key + '}' not in path}
    path = path.format(**args)
    if operation == 'create':
        body = args['spec']
    elif operation == 'review':
        body = args['review']
    return method, path, body


async def _evaluations(client, tasks, args: dict) -> dict:
    """Forward one bounded request using only the authenticated MCP caller."""
    try:
        method, path, body = _request_args(args)
    except (ValueError, TypeError) as exc:
        return _bad(str(exc), 'Use the operation schema; call capabilities before creating runs')

    credential = CALLER_AUTH.get()
    if not credential:
        return {
            'ok': False,
            'error_type': 'AuthenticationRequired',
            'message': 'Managed evaluations require an authenticated caller; a service credential is never substituted.',
        }

    origin = urlsplit(client.base_url)
    if (
        origin.scheme not in ('http', 'https')
        or not origin.netloc
        or origin.username
        or origin.password
        or origin.query
        or origin.fragment
    ):
        return {'ok': False, 'error_type': 'ConfigurationError', 'message': 'The engine HTTP origin is invalid.'}
    url = urlunsplit((origin.scheme, origin.netloc, '/evals/v1' + path, '', ''))

    try:
        # No retries or redirects: a lost POST response is not permission to
        # launch another experiment, and redirects must not move credentials.
        async with httpx.AsyncClient(timeout=30, follow_redirects=False, trust_env=False) as http:
            async with http.stream(
                method,
                url,
                headers={'Authorization': f'Bearer {credential}'},
                **({'params': body} if method == 'GET' else {'json': body}),
            ) as response:
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    chunks.extend(chunk)
                    if len(chunks) > _MAX_RESPONSE_BYTES:
                        return {
                            'ok': False,
                            'error_type': 'ResponseTooLarge',
                            'message': 'Download this report through the CLI or API.',
                        }
                content = bytes(chunks).decode('utf-8', errors='replace')
                if 300 <= response.status_code < 400:
                    return {
                        'ok': False,
                        'error_type': 'RedirectRefused',
                        'status': response.status_code,
                        'message': 'Configure the final engine origin; redirects are not followed.',
                    }
                if response.is_error:
                    try:
                        error = json.loads(content).get('error', {})
                        message = (
                            error.get('message', 'Evaluation request failed')
                            if isinstance(error, dict)
                            else 'Evaluation request failed'
                        )
                    except (ValueError, AttributeError):
                        message = 'Evaluation service unavailable or response was not JSON'
                    return {
                        'ok': False,
                        'error_type': 'EvaluationError',
                        'status': response.status_code,
                        'message': str(message).replace(credential, '[redacted]')[:2000],
                    }
                if args['operation'] == 'report' and args.get('format') == 'junit':
                    return {'ok': True, 'format': 'junit', 'report': content}
                result = json.loads(content)
                if not isinstance(result, dict):
                    raise ValueError('Expected an evaluation response object')
                return {**result, 'ok': True}
    except httpx.RequestError:
        return {
            'ok': False,
            'error_type': 'TransportError',
            'message': 'The evaluation service did not respond. A write may have completed: query its status and reuse the original idempotency key before retrying a run.',
        }
    except (ValueError, UnicodeError):
        return {
            'ok': False,
            'error_type': 'InvalidResponse',
            'message': 'The evaluation service returned an invalid response.',
        }


def register(registry: ToolRegistry) -> None:
    """Expose the same managed operations available through rocketride evals."""
    registry.register(
        'evaluations',
        'Manage native RocketRide evaluations without changing business pipelines. '
        'Call capabilities first (requires a SaaS server). list/get/runs/status/report read evidence; '
        'create/revise save versioned EvalSpecs; run launches real, potentially billable pipeline trials '
        'and requires a stable idempotencyKey; cancel stops a run. baseline and review record human '
        'decisions: only use them when the user explicitly authorizes the decision. assist proposes '
        'a spec through the configured native agent and never applies or runs it. Review proposed '
        'cases before approving them; trace playback alone does not make a reproducible test. '
        'Use the same operations via rocketride evals for scripts and CI; MCP itself does not provide shell access.',
        {
            'type': 'object',
            'additionalProperties': False,
            'required': ['operation'],
            'properties': {
                'operation': {'type': 'string', 'enum': list(_OPERATIONS)},
                'projectId': {'type': 'string'},
                'evaluationId': {'type': 'string'},
                'runId': {'type': 'string'},
                'baselineRunId': {'type': 'string'},
                'spec': {'type': 'object', 'description': 'Version 1 EvalSpec; use get to retrieve a saved spec.'},
                'revision': {'type': 'integer', 'minimum': 1},
                'expectedRevision': {'type': 'integer', 'minimum': 1},
                'idempotencyKey': {'type': 'string', 'minLength': 1, 'maxLength': 128},
                'format': {'type': 'string', 'enum': ['json', 'junit']},
                'instruction': {'type': 'string', 'maxLength': 16000},
                'review': {
                    'type': 'object',
                    'additionalProperties': False,
                    'required': ['caseId', 'scorerId', 'status', 'reason', 'expectedReportRevision'],
                    'properties': {
                        'caseId': {'type': 'string'},
                        'scorerId': {'type': 'string'},
                        'caseResultId': {
                            'type': 'string',
                            'description': 'Exact run.cases[].id, required for repeated trials.',
                        },
                        'status': {'type': 'string', 'enum': ['pass', 'fail', 'abstain']},
                        'reason': {'type': 'string'},
                        'expectedReportRevision': {'type': 'integer', 'minimum': 1},
                    },
                },
            },
            'allOf': [
                {'if': {'properties': {'operation': {'const': name}}}, 'then': {'required': list(required)}}
                for name, (_, _, required, _) in _OPERATIONS.items()
                if required
            ],
        },
    )(_evaluations)
