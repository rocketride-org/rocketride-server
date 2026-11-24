# Copyright 2026 Aparavi Software AG. MIT License.
"""Result schemas: the ``outputSchema`` of every MCP tool, keyed by tool name.

The dispatcher sends one JSON object for every outcome, as text and as
``structuredContent`` (``handlers.py``). So each schema is a union:
``{'type': 'object', 'oneOf': [<success>..., ERROR_RESULT]}``. ``ok`` tells
the branches apart: ``const: true`` in a success branch, ``const: false`` in
the shared error envelope. ``validate_pipeline`` and ``probe_component`` share
the one success branch that allows ``ok: false`` (a validation result, not an
error envelope).

A client that validates (the MCP Python SDK does, on every result that is not
an error) fails the call when a result does not match. So a type is decided by
who produces the value:

- The handler computes or checks it (a literal, ``len()``, ``bool()``, a
  checked argument): typed exactly.
- The caller authored it, or the handler echoes an argument it only tests for
  truthiness (paths, ids, pipeline JSON): untyped (``ANY``). Dispatch does not
  apply the input schema, so the server cannot promise the echo's type.
- The engine or the SDK produces it: typed per the producing code, with
  ``null`` allowed where the handler reads it with ``.get``.

A success branch requires only the keys its handler always sets. Engine-owned
records have typed optional properties and no required keys. No object is
closed: extra keys are always allowed.

``RESULT_SCHEMAS`` has a row for every registered tool (the contract test fails
a tool without one), and may hold rows for tools not registered here. To loosen
a row that rejects a real result, replace its success branch with
``success({})``; never delete the row.
"""

from typing import Any, Dict, Iterable, Optional

ANY: Dict[str, Any] = {}


def typed(kind: str, **extra: Any) -> Dict[str, Any]:
    """``{'type': kind}`` plus any extra keywords (description, enum, ...)."""
    return {'type': kind, **extra}


def nullable(kind: str, **extra: Any) -> Dict[str, Any]:
    """``kind`` or ``null``, for engine values the handler reads with ``.get``."""
    return {'type': [kind, 'null'], **extra}


def array(items: Optional[Dict[str, Any]] = None, **extra: Any) -> Dict[str, Any]:
    """An array, optionally with an item schema."""
    out: Dict[str, Any] = {'type': 'array', **extra}
    if items is not None:
        out['items'] = items
    return out


def record(properties: Optional[Dict[str, Any]] = None, required: Iterable[str] = (), **extra: Any) -> Dict[str, Any]:
    """An open object; ``required`` lists only keys the producer always sets."""
    out: Dict[str, Any] = {'type': 'object', **extra}
    if properties:
        out['properties'] = properties
    required = list(required)
    if required:
        out['required'] = required
    return out


STRING = typed('string')
INTEGER = typed('integer')
BOOLEAN = typed('boolean')
OBJECT = typed('object')
STRINGS = array(STRING)

ERROR_RESULT: Dict[str, Any] = {
    'type': 'object',
    'title': 'Error',
    'description': (
        'The call failed and isError is true. error_type names the failure, for example BadRequest, '
        'NotFound or Timeout. Read hint before retrying.'
    ),
    'properties': {
        'ok': {'const': False},
        'error_type': STRING,
        'message': STRING,
        'hint': nullable('string'),
    },
    'required': ['ok', 'error_type', 'message', 'hint'],
}


def success(
    properties: Dict[str, Any],
    required: Iterable[str] = (),
    *,
    title: str = 'Success',
    description: Optional[str] = None,
    ok: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """One success branch: ``ok`` (``const: true`` unless given) plus ``properties``."""
    if ok is None:
        ok = {'const': True}
    branch: Dict[str, Any] = {
        'type': 'object',
        'title': title,
        'properties': {'ok': ok, **properties},
        'required': ['ok', *required],
    }
    if description:
        branch['description'] = description
    return branch


def result_schema(*branches: Dict[str, Any]) -> Dict[str, Any]:
    """A tool's ``outputSchema``: one of its success branches, or the error envelope."""
    return {'type': 'object', 'oneOf': [*branches, ERROR_RESULT]}


def paged(
    rows_key: str, item: Dict[str, Any], extra: Optional[Dict[str, Any]] = None, extra_required: Iterable[str] = ()
) -> Dict[str, Any]:
    """The success branch of a ``capability.list_envelope_payload`` result.

    The handler computes ``count``. ``total``, ``page`` and ``pageSize`` are the
    engine's values, read with ``.get``.
    """
    return success(
        {
            **(extra or {}),
            rows_key: array(item),
            'count': typed('integer', description='Rows on this page.'),
            'total': nullable('integer', description='Rows that match in all. More pages exist when count < total.'),
            'page': nullable('integer'),
            'pageSize': nullable('integer'),
        },
        [*extra_required, rows_key, 'count', 'total', 'page', 'pageSize'],
    )


# --------------------------------------------------------------------------
# Shared records
# --------------------------------------------------------------------------

CREDENTIAL_STATUS = typed('string', enum=['configured', 'available', 'unconfirmed'])

WIRING = {
    'type': ['object', 'null'],
    'description': 'Config entries that bind the integration to saved variables. Null when there is nothing to bind.',
}

CREDENTIAL_STATE = record(
    {
        'status': CREDENTIAL_STATUS,
        'missing': STRINGS,
        'candidates': STRINGS,
        'wiring': WIRING,
        'setup': record({'variables': STRINGS, 'how': STRING, 'docs': STRING}),
        'hosted': BOOLEAN,
        'note': STRING,
    },
    ['status', 'missing', 'candidates'],
)

DEPLOYMENT = record(
    {
        'projectId': STRING,
        'teamId': STRING,
        'version': INTEGER,
        'state': STRING,
        'pipelineName': STRING,
        'schedules': OBJECT,
        'userId': nullable('string'),
        'billingTeamId': nullable('string'),
        'createdAt': nullable('number'),
        'updatedAt': nullable('number'),
        'deployedAt': nullable('number'),
        'publishedAt': nullable('number'),
        'sha256': STRING,
        'createdBy': nullable('object'),
        'updatedBy': nullable('object'),
        'publishedBy': nullable('object'),
    }
)

ARTIFACT = record(
    {
        'version': INTEGER,
        'sha256': STRING,
        'bytes': INTEGER,
        'kind': STRING,
        'state': STRING,
        'pipelineName': STRING,
        'comment': STRING,
        'artifactPath': STRING,
        'metadata': ANY,
        'publishedAt': nullable('number'),
        'publishedBy': nullable('object'),
    }
)

STORE_ENTRY = record(
    {
        'name': STRING,
        'type': STRING,
        'size': INTEGER,
        'modified': typed('number'),
        'virtual': BOOLEAN,
        'id': STRING,
    }
)

STORE_STAT = record(
    {
        'exists': BOOLEAN,
        'type': typed('string', description='file, dir or both'),
        'size': INTEGER,
        'modified': typed('number'),
        'virtual': BOOLEAN,
    },
    ['exists'],
)

RUNNING_TASK = record(
    {
        'name': ANY,
        'description': STRING,
        'source': ANY,
        'token': STRING,
        'status': STRING,
        'teamId': nullable('string'),
        'runKind': nullable('string'),
        'ownerKind': nullable('string'),
        'ownerId': nullable('string'),
        'pipeline': ANY,
    }
)

CHAPTER = record(
    {
        'beginTime': nullable('number'),
        'beginSeq': nullable('integer'),
        'endTime': nullable('number'),
        'outcome': nullable('string'),
        'traceLevel': nullable('string'),
    }
)

LOG_EVENT = record({'type': STRING, 'event': STRING, 'body': OBJECT})

TRACE_SUMMARY = record(
    {
        'id': ANY,
        'beginSeq': nullable('integer'),
        'doc': nullable('string'),
        'beginTime': nullable('number'),
        'elapsed': nullable('number'),
        'calls': nullable('integer'),
        'open': BOOLEAN,
        'touched': nullable('array'),
    }
)

LOG_CONTEXT = record({'projectId': ANY, 'source': ANY, 'teamId': ANY}, ['projectId', 'source'])

_VALIDATION_RESULT = result_schema(
    success(
        {
            'errors': {'description': 'The engine diagnostics, normally a list.'},
            'warnings': ANY,
        },
        ['errors', 'warnings'],
        title='Validation',
        description='ok is false when errors is not empty. This is a validation result, not an error envelope, '
        'although isError is true when ok is false.',
        ok=BOOLEAN,
    )
)

_DEPLOYMENT_RESULT = result_schema(success({'deployment': DEPLOYMENT}, ['deployment']))

_TEAM_WARNINGS = array(STRING, description='Things to tell the user about this deployment.')

# --------------------------------------------------------------------------
# One row per tool
# --------------------------------------------------------------------------

RESULT_SCHEMAS: Dict[str, Dict[str, Any]] = {
    # introspection
    'list_components': result_schema(
        success(
            {
                'components': array(
                    record(
                        {'name': STRING, 'category': ANY, 'summary': ANY, 'wiring': WIRING},
                        ['name', 'category', 'summary'],
                    )
                ),
                'note': STRING,
            },
            ['components'],
        )
    ),
    'describe_component': result_schema(
        success(
            {'credentials': CREDENTIAL_STATE},
            description="The component's service definition (title, protocol, classType, lanes, config) is spread "
            'at the top level.',
        )
    ),
    'resolve_config': result_schema(
        success({'provider': ANY, 'profile': ANY, 'resolved': OBJECT, 'dropped': STRINGS, 'hint': STRING})
    ),
    'validate_pipeline': _VALIDATION_RESULT,
    'describe_pipeline': result_schema(
        success(
            {
                'source': ANY,
                'components': array(
                    record(
                        {'id': ANY, 'provider': ANY, 'title': ANY, 'classType': ANY, 'inputs': ANY},
                        ['id', 'provider', 'title', 'classType', 'inputs'],
                    )
                ),
            },
            ['source', 'components'],
        )
    ),
    # execution
    'run_pipeline': result_schema(
        success(
            {'task_token': STRING, 'projectId': ANY, 'source': ANY, 'result': ANY},
            ['task_token', 'projectId', 'source'],
        )
    ),
    'run_dropper_pipe': result_schema(
        success(
            {'task_token': STRING, 'upload_url': STRING, 'dropper_url': STRING, 'projectId': ANY, 'source': ANY},
            ['task_token', 'upload_url', 'dropper_url', 'projectId', 'source'],
        )
    ),
    'send_data': result_schema(success({'result': ANY}, ['result'])),
    'terminate': result_schema(
        success({'terminated': {'description': 'The task_token argument, echoed.'}}, ['terminated'])
    ),
    'send_files': result_schema(success({'result': ANY}, ['result'])),
    # store and templates
    'store_read': result_schema(success({'path': ANY, 'content': STRING}, ['path', 'content'])),
    'store_list': result_schema(
        success(
            {'path': ANY, 'listing': record({'entries': array(STORE_ENTRY), 'count': INTEGER})}, ['path', 'listing']
        )
    ),
    'store_stat': result_schema(success({'path': ANY, 'stat': STORE_STAT}, ['path', 'stat'])),
    'store_get_url': result_schema(
        success({'path': ANY, 'url': STRING, 'expires_in': INTEGER}, ['path', 'url', 'expires_in'])
    ),
    'save_template': result_schema(success({'template_id': ANY}, ['template_id'])),
    'load_template': result_schema(success({'template_id': ANY, 'pipeline': ANY}, ['template_id', 'pipeline'])),
    # deployments
    'deploy_add': result_schema(
        success(
            {
                'artifact': {'oneOf': [ARTIFACT, {'type': 'null'}]},
                'deployment': DEPLOYMENT,
                'warnings': _TEAM_WARNINGS,
            },
            ['artifact'],
        )
    ),
    'deploy_list': result_schema(paged('deployments', DEPLOYMENT)),
    'deploy_status': _DEPLOYMENT_RESULT,
    'deploy_versions': result_schema(paged('versions', ARTIFACT, {'project_id': ANY}, ['project_id'])),
    'deploy_to_team': result_schema(success({'deployment': DEPLOYMENT, 'warnings': _TEAM_WARNINGS}, ['deployment'])),
    'deploy_set_schedule': _DEPLOYMENT_RESULT,
    'deploy_enable': _DEPLOYMENT_RESULT,
    'deploy_disable': _DEPLOYMENT_RESULT,
    'deploy_remove': _DEPLOYMENT_RESULT,
    # visibility
    'monitor': result_schema(
        success(
            {
                'task_token': ANY,
                'state': nullable('integer'),
                'state_label': STRING,
                'completed': BOOLEAN,
                'terminal': BOOLEAN,
                'status': OBJECT,
                'counts': record(
                    {
                        'completedCount': nullable('integer'),
                        'failedCount': nullable('integer'),
                        'totalCount': nullable('integer'),
                    },
                    ['completedCount', 'failedCount', 'totalCount'],
                ),
                'errors': ANY,
                'warnings': ANY,
                'polls': INTEGER,
                'poll_timed_out': {'const': True},
            },
            [
                'task_token',
                'state',
                'state_label',
                'completed',
                'terminal',
                'status',
                'counts',
                'errors',
                'warnings',
                'polls',
            ],
        )
    ),
    'list_running_pipelines': result_schema(
        success({'tasks': array(RUNNING_TASK), 'count': INTEGER}, ['tasks', 'count'])
    ),
    # run logs
    'log_chapters': result_schema(
        success({'chapters': array(CHAPTER), 'horizonSeq': nullable('integer')}, ['chapters', 'horizonSeq'])
    ),
    'log_read': result_schema(
        success(
            {'events': array(LOG_EVENT), 'nextCursor': nullable('integer'), 'truncatedAtSeq': nullable('integer')},
            ['events', 'nextCursor', 'truncatedAtSeq'],
        )
    ),
    'log_traces': result_schema(
        success(
            {'traces': array(TRACE_SUMMARY), 'open': array(TRACE_SUMMARY), 'context': LOG_CONTEXT, 'note': STRING},
            ['traces', 'open', 'context'],
        )
    ),
    'log_trace': result_schema(
        success(
            {
                'beginSeq': INTEGER,
                'summary': {'oneOf': [TRACE_SUMMARY, {'type': 'null'}]},
                'events': array(LOG_EVENT),
                'context': LOG_CONTEXT,
            },
            ['beginSeq', 'summary', 'events', 'context'],
        )
    ),
    # scaffold
    'scaffold_node': result_schema(
        success(
            {
                'name': STRING,
                'provider': STRING,
                'files': record(additionalProperties=STRING, description='File contents keyed by relative path.'),
                'next_steps': STRINGS,
            },
            ['name', 'provider', 'files', 'next_steps'],
        )
    ),
    # integrations
    'list_integrations': result_schema(
        success(
            {
                'integrations': array(
                    record(
                        {
                            'name': STRING,
                            'title': STRING,
                            'status': CREDENTIAL_STATUS,
                            'missing_count': INTEGER,
                            'hosted': BOOLEAN,
                        },
                        ['name', 'title', 'status', 'missing_count'],
                    )
                ),
                'note': STRING,
            },
            ['integrations', 'note'],
            title='Listing',
        ),
        success(
            {
                'name': STRING,
                'title': STRING,
                'fields': array(
                    record(
                        {'path': STRING, 'title': STRING, 'kind': STRING, 'required': BOOLEAN, 'suggests': STRING},
                        ['path', 'title', 'kind', 'required', 'suggests'],
                    )
                ),
                'caller_variables': STRINGS,
                **CREDENTIAL_STATE['properties'],
            },
            ['name', 'title', 'fields', 'caller_variables', 'status', 'missing', 'candidates'],
            title='Detail',
        ),
    ),
    # Tools registered by other modules once they land. probe_component returns what validate_pipeline does.
    'probe_component': _VALIDATION_RESULT,
    'view_pipeline': result_schema(
        success(
            {
                'path': STRING,
                'workspace': STRING,
                'name': STRING,
                'description': STRING,
                'node_count': INTEGER,
                'truncated': BOOLEAN,
                'nodes': array(record({'id': STRING, 'provider': STRING, 'title': ANY}, ['id', 'provider', 'title'])),
                'connections': array(
                    record({'from': STRING, 'to': STRING, 'lane': STRING, 'control': STRING}, ['from', 'to'])
                ),
            },
            ['path', 'workspace', 'name', 'description', 'node_count', 'truncated', 'nodes', 'connections'],
        )
    ),
    'account_status': result_schema(
        success(
            {
                'ready': BOOLEAN,
                'edition': typed('string', enum=['cloud', 'self-hosted']),
                'summary': STRING,
                'checks': array(
                    record(
                        {
                            'id': STRING,
                            'ok': nullable('boolean'),
                            'detail': STRING,
                            'next_step': STRING,
                            'tokens': typed('number'),
                            'blocking': BOOLEAN,
                        },
                        ['id', 'ok', 'detail'],
                    )
                ),
                'hint': STRING,
            },
            ['ready', 'edition', 'summary', 'checks'],
        )
    ),
}
