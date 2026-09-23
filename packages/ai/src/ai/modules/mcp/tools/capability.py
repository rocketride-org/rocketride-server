# Copyright 2026 Aparavi Software AG. MIT License.
"""Capability tools: store + templates (`store_read`, `store_list`,
`store_stat`, `store_get_url`, `save_template`, `load_template`), and
deployments (`deploy_add`, `deploy_list`, `deploy_status`, `deploy_versions`,
`deploy_to_team`, `deploy_set_schedule`, `deploy_enable`, `deploy_disable`,
`deploy_remove`).

The deployment tools are thin wrappers over ``rocketride.deploy.DeployApi``,
one SDK call each, in its teams-as-environments model: `deploy_add` registers
an immutable, numbered version of a project in the org registry;
`deploy_to_team` points a team (the environment) at a version; schedules and
enable/disable/remove act on one team's deployment, addressed by
(project_id, team_id).
"""

from typing import Any, Dict, Optional

from ..errors import _bad
from ..tooling import ToolRegistry
from ._common import engine_call as _engine_call
from ._common import load_pipeline


_PIPELINE_SCHEMA_PROPS = {
    'pipeline': {'type': 'object', 'description': 'Inline pipeline definition'},
}

_STORE_READ_SCHEMA = {
    'type': 'object',
    'properties': {
        'path': {'type': 'string', 'description': 'Store-relative file path'},
    },
    'required': ['path'],
}

_STORE_LIST_SCHEMA = {
    'type': 'object',
    'properties': {
        'path': {'type': 'string', 'description': "Store-relative directory path (default '' = root)"},
    },
}

_STORE_STAT_SCHEMA = {
    'type': 'object',
    'properties': {
        'path': {'type': 'string', 'description': 'Store-relative file or directory path'},
    },
    'required': ['path'],
}

_STORE_GET_URL_SCHEMA = {
    'type': 'object',
    'properties': {
        'path': {'type': 'string', 'description': 'Store-relative file path'},
        'expires_in': {'type': 'integer', 'minimum': 1, 'description': 'URL lifetime in seconds (default 3600)'},
        'download_name': {'type': 'string', 'description': 'Optional filename for the browser download'},
    },
    'required': ['path'],
}

_SAVE_TEMPLATE_SCHEMA = {
    'type': 'object',
    'properties': {
        'template_id': {'type': 'string', 'description': 'Identifier to save the template under'},
        **_PIPELINE_SCHEMA_PROPS,
    },
    'required': ['template_id', 'pipeline'],
}

_LOAD_TEMPLATE_SCHEMA = {
    'type': 'object',
    'properties': {
        'template_id': {'type': 'string', 'description': 'Identifier of a previously saved template'},
    },
    'required': ['template_id'],
}

_PROJECT_ID_PROP = {
    'project_id': {
        'type': 'string',
        'description': "Project id: the pipeline's project_id, or projectId on a deploy_list row",
    },
}

_TEAM_ID_PROP = {
    'team_id': {
        'type': 'string',
        'description': (
            'Team id -- the environment (e.g. Staging, Production): teamId on a deploy_list row, '
            "or '@me' for your personal space"
        ),
    },
}

_PAGING_PROPS = {
    'page': {'type': 'integer', 'minimum': 1, 'description': '1-based page number (default 1)'},
    'page_size': {
        'type': 'integer',
        'minimum': 1,
        'description': 'Rows per page (server default 50, clamped to 100)',
    },
}

_DEPLOYMENT_KEY_SCHEMA = {
    'type': 'object',
    'properties': {**_PROJECT_ID_PROP, **_TEAM_ID_PROP},
    'required': ['project_id', 'team_id'],
}

_DEPLOY_ADD_SCHEMA = {
    'type': 'object',
    'properties': {
        'pipeline': {
            'type': 'object',
            'description': 'Inline pipeline definition; must carry name and project_id',
        },
        'comment': {'type': 'string', 'description': 'Optional "what changed" note kept with the version'},
        'deploy_to': {
            'type': 'string',
            'description': (
                'Optional team id to point at the new version in the same call '
                "(same as deploy_to_team; '@me' for your personal space)"
            ),
        },
    },
    'required': ['pipeline'],
}

_DEPLOY_LIST_SCHEMA = {
    'type': 'object',
    'properties': {
        'team_id': {
            'type': 'string',
            'description': "Restrict to one team ('@me' = your personal space); omit for every deployment you can see",
        },
        **_PAGING_PROPS,
        'search': {'type': 'string', 'description': 'Free-text search over projectId, pipelineName and teamId'},
        'filters': {'type': 'object', 'description': 'Column filters, e.g. {"state": "enabled"}'},
        'sort': {
            'type': 'array',
            'description': 'Sorters, e.g. [{"field": "updatedAt", "dir": "desc"}] (default updatedAt desc)',
            'items': {
                'type': 'object',
                'properties': {'field': {'type': 'string'}, 'dir': {'type': 'string', 'enum': ['asc', 'desc']}},
                'required': ['field'],
            },
        },
    },
}

_DEPLOY_VERSIONS_SCHEMA = {
    'type': 'object',
    'properties': {**_PROJECT_ID_PROP, **_PAGING_PROPS},
    'required': ['project_id'],
}

_DEPLOY_TO_TEAM_SCHEMA = {
    'type': 'object',
    'properties': {
        **_PROJECT_ID_PROP,
        'version': {
            'type': 'integer',
            'minimum': 1,
            'description': "Registry version: artifact.version from deploy_add, or a row's version from deploy_versions",
        },
        **_TEAM_ID_PROP,
    },
    'required': ['project_id', 'version', 'team_id'],
}

_DEPLOY_SET_SCHEDULE_SCHEMA = {
    'type': 'object',
    'properties': {
        **_PROJECT_ID_PROP,
        'source_id': {
            'type': 'string',
            'description': 'Id of the source component the schedule fires; must exist in the deployed version',
        },
        'schedule': {
            'type': 'string',
            'description': "5-field cron expression, or 'manual' to clear the schedule",
        },
        **_TEAM_ID_PROP,
        'ttl': {
            'type': 'integer',
            'minimum': 1,
            'description': 'Optional run window in seconds; omit to run each task until the pipeline finishes',
        },
    },
    'required': ['project_id', 'source_id', 'schedule', 'team_id'],
}

_MISSING_HINTS = {
    'project_id': "pass the pipeline's project_id (or projectId from a deploy_list row)",
    'team_id': "pass teamId from a deploy_list row, or '@me' for your personal space",
    'source_id': 'pass the id of a source component in the deployed pipeline',
    'schedule': "pass a 5-field cron expression, or 'manual' to clear the schedule",
}


async def _store_read(client, tasks, args: Dict[str, Any]) -> dict:
    path = args.get('path')
    if not path:
        return _bad('path is required', 'pass a store file path (see store_list)')

    content, err = await _engine_call(client.fs_read_string(path), 'store_read')
    if err:
        return err
    return {'ok': True, 'path': path, 'content': content}


async def _store_list(client, tasks, args: Dict[str, Any]) -> dict:
    path = args.get('path') or ''
    listing, err = await _engine_call(client.fs_list_dir(path), 'store_list')
    if err:
        return err
    return {'ok': True, 'path': path, 'listing': listing}


async def _store_stat(client, tasks, args: Dict[str, Any]) -> dict:
    path = args.get('path')
    if not path:
        return _bad('path is required', 'pass a store file or directory path (see store_list)')

    stat, err = await _engine_call(client.fs_stat(path), 'store_stat')
    if err:
        return err
    return {'ok': True, 'path': path, 'stat': stat}


async def _store_get_url(client, tasks, args: Dict[str, Any]) -> dict:
    path = args.get('path')
    if not path:
        return _bad('path is required', 'pass a store file path (see store_list)')

    expires_in = args.get('expires_in')
    if expires_in is None:
        expires_in = 3600
    elif not isinstance(expires_in, int) or isinstance(expires_in, bool) or expires_in < 1:
        return _bad('expires_in must be a positive integer', 'omit it to use the 3600-second default')
    url, err = await _engine_call(
        client.fs_get_url(path, expires_in=expires_in, download_name=args.get('download_name')), 'store_get_url'
    )
    if err:
        return err
    return {'ok': True, 'path': path, 'url': url, 'expires_in': expires_in}


async def _save_template(client, tasks, args: Dict[str, Any]) -> dict:
    template_id = args.get('template_id')
    if not template_id:
        return _bad('template_id is required', 'name the template')

    pipeline = load_pipeline(args)  # raises ValueError -> normalized by the dispatch layer
    _, err = await _engine_call(client.save_template(template_id, pipeline), 'save_template')
    if err:
        return err
    return {'ok': True, 'template_id': template_id}


async def _load_template(client, tasks, args: Dict[str, Any]) -> dict:
    template_id = args.get('template_id')
    if not template_id:
        return _bad('template_id is required', 'pass a saved template id')

    # ``get_template`` round-trips the raw pipeline dict saved by
    # ``save_template`` (see rocketride.mixins.store: both sides read/write
    # `.templates/<id>.json` as the bare pipeline, with no wrapping record) --
    # return it directly rather than unwrapping a nonexistent ``pipeline`` key.
    pipeline, err = await _engine_call(client.get_template(template_id), 'load_template')
    if err:
        return err
    return {'ok': True, 'template_id': template_id, 'pipeline': pipeline}


def _missing(args: Dict[str, Any], *keys: str) -> Optional[dict]:
    """``_bad`` for the first of ``keys`` absent from ``args``, else ``None``."""
    for key in keys:
        if not args.get(key):
            return _bad(f'{key} is required', _MISSING_HINTS[key])
    return None


def _is_positive_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 1


def _bad_paging(args: Dict[str, Any]) -> Optional[dict]:
    """``_bad`` for a supplied ``page``/``page_size`` that is not a positive integer."""
    for key in ('page', 'page_size'):
        if args.get(key) is not None and not _is_positive_int(args[key]):
            return _bad(f'{key} must be a positive integer', f'omit {key} to use the server default')
    return None


def list_envelope_payload(envelope: Optional[Dict[str, Any]], rows_key: str) -> Dict[str, Any]:
    """Unwrap the SDK's standard list envelope (``{rows, total, page, pageSize}``).

    ``count`` is the rows on this page; ``total`` counts every match, so
    ``count < total`` means more pages. Shared with the
    ``rocketride://pipelines`` resource.
    """
    envelope = envelope or {}
    rows = envelope.get('rows') or []
    return {
        rows_key: rows,
        'count': len(rows),
        'total': envelope.get('total', len(rows)),
        'page': envelope.get('page'),
        'pageSize': envelope.get('pageSize'),
    }


async def _deploy_add(client, tasks, args: Dict[str, Any]) -> dict:
    pipeline = load_pipeline(args)  # raises ValueError -> normalized by the dispatch layer
    result, err = await _engine_call(
        client.deploy_add(pipeline, comment=args.get('comment'), deploy_to=args.get('deploy_to')), 'deploy_add'
    )
    if err:
        # Non-idempotent create: the engine may have registered the version
        # before the local budget elapsed -- a blind retry adds another one.
        err['hint'] = 'a new version may already be registered; call deploy_versions before retrying deploy_add'
        return err
    result = result or {}
    payload = {'ok': True, 'artifact': result.get('artifact')}
    if result.get('deployment') is not None:
        payload['deployment'] = result['deployment']
    return payload


async def _deploy_list(client, tasks, args: Dict[str, Any]) -> dict:
    err = _bad_paging(args)
    if err:
        return err
    envelope, err = await _engine_call(
        client.deploy_list(
            team_id=args.get('team_id'),
            page=args.get('page'),
            page_size=args.get('page_size'),
            search=args.get('search'),
            filters=args.get('filters'),
            sort=args.get('sort'),
        ),
        'deploy_list',
    )
    if err:
        return err
    return {'ok': True, **list_envelope_payload(envelope, 'deployments')}


async def _deploy_status(client, tasks, args: Dict[str, Any]) -> dict:
    err = _missing(args, 'project_id', 'team_id')
    if err:
        return err
    deployment, err = await _engine_call(client.deploy_get(args['project_id'], args['team_id']), 'deploy_status')
    if err:
        return err
    return {'ok': True, 'deployment': deployment}


async def _deploy_versions(client, tasks, args: Dict[str, Any]) -> dict:
    err = _missing(args, 'project_id') or _bad_paging(args)
    if err:
        return err
    project_id = args['project_id']
    envelope, err = await _engine_call(
        client.deploy_versions(project_id, page=args.get('page'), page_size=args.get('page_size')),
        'deploy_versions',
    )
    if err:
        return err
    return {'ok': True, 'project_id': project_id, **list_envelope_payload(envelope, 'versions')}


async def _deploy_to_team(client, tasks, args: Dict[str, Any]) -> dict:
    err = _missing(args, 'project_id', 'team_id')
    if err:
        return err
    version = args.get('version')
    if not _is_positive_int(version):
        return _bad(
            'version is required and must be a positive integer',
            'pass artifact.version from deploy_add, or a version from deploy_versions',
        )
    deployment, err = await _engine_call(
        client.deploy_deploy(args['project_id'], version, args['team_id']), 'deploy_to_team'
    )
    if err:
        return err
    return {'ok': True, 'deployment': deployment}


async def _deploy_set_schedule(client, tasks, args: Dict[str, Any]) -> dict:
    err = _missing(args, 'project_id', 'source_id', 'schedule', 'team_id')
    if err:
        return err
    ttl = args.get('ttl')
    if ttl is not None and not _is_positive_int(ttl):
        return _bad('ttl must be a positive integer (seconds)', 'omit ttl to run each task until the pipeline finishes')
    deployment, err = await _engine_call(
        client.deploy_set_schedule(args['project_id'], args['source_id'], args['schedule'], args['team_id'], ttl=ttl),
        'deploy_set_schedule',
    )
    if err:
        return err
    return {'ok': True, 'deployment': deployment}


def _state_tool(seam_method: str, tool_name: str):
    """Build the handler for one (project_id, team_id) state change."""

    async def _handler(client, tasks, args: Dict[str, Any]) -> dict:
        err = _missing(args, 'project_id', 'team_id')
        if err:
            return err
        deployment, err = await _engine_call(
            getattr(client, seam_method)(args['project_id'], args['team_id']), tool_name
        )
        if err:
            return err
        return {'ok': True, 'deployment': deployment}

    return _handler


_deploy_enable = _state_tool('deploy_enable', 'deploy_enable')
_deploy_disable = _state_tool('deploy_disable', 'deploy_disable')
_deploy_remove = _state_tool('deploy_remove', 'deploy_remove')


def register(registry: ToolRegistry) -> None:
    """Register the store, template, and deployment tools against ``registry``.

    Store: `store_read`, `store_list`, `store_stat`, `store_get_url`.
    Templates: `save_template`, `load_template`.
    Deployments: `deploy_add`, `deploy_list`, `deploy_status`, `deploy_versions`,
    `deploy_to_team`, `deploy_set_schedule`, `deploy_enable`, `deploy_disable`,
    `deploy_remove`.
    """
    registry.register(
        'store_read',
        'Read a text file from the RocketRide store by its store-relative path.',
        _STORE_READ_SCHEMA,
    )(_store_read)

    registry.register(
        'store_list',
        "List entries under a store-relative directory path (default '' = root).",
        _STORE_LIST_SCHEMA,
    )(_store_list)

    registry.register(
        'store_stat',
        'Get metadata for a store file or directory: exists, type (file|dir), size, modified.',
        _STORE_STAT_SCHEMA,
    )(_store_stat)

    registry.register(
        'store_get_url',
        'Get a time-limited signed download URL for a store file -- the out-of-band '
        'counterpart to store_read for large files that cannot ride an in-band result.',
        _STORE_GET_URL_SCHEMA,
    )(_store_get_url)

    registry.register(
        'save_template',
        'Save an inline pipeline as a reusable template under a template_id.',
        _SAVE_TEMPLATE_SCHEMA,
    )(_save_template)

    registry.register(
        'load_template',
        'Load a previously saved pipeline template by its template_id.',
        _LOAD_TEMPLATE_SCHEMA,
    )(_load_template)

    registry.register(
        'deploy_add',
        'Register an inline pipeline as the next immutable version of its project in the org registry '
        '(the pipeline must carry name and project_id). Returns artifact.version. Registering does not '
        'run anything: pass deploy_to, or call deploy_to_team next, to put the version live on a team; '
        'then deploy_set_schedule to run it on a cron.',
        _DEPLOY_ADD_SCHEMA,
    )(_deploy_add)

    registry.register(
        'deploy_list',
        'List the team deployments you can see (your teams and personal space; the whole org for an '
        'org admin), one row per (projectId, teamId) with its version, state and per-source schedules. '
        'Paged: count is the rows returned, total every match.',
        _DEPLOY_LIST_SCHEMA,
    )(_deploy_list)

    registry.register(
        'deploy_status',
        "Get one team's deployment of a project: version, state, per-source schedules, and who deployed it when.",
        _DEPLOYMENT_KEY_SCHEMA,
    )(_deploy_status)

    registry.register(
        'deploy_versions',
        "List a project's registered versions, newest first (version, pipelineName, comment, "
        'publishedAt) -- the versions deploy_to_team can point a team at.',
        _DEPLOY_VERSIONS_SCHEMA,
    )(_deploy_versions)

    registry.register(
        'deploy_to_team',
        'Point a team (the environment) at a registered version of a project. First deploy, promotion '
        '(the same version to another team) and rollback (an older version) are all this call; a '
        'removed deployment is revived.',
        _DEPLOY_TO_TEAM_SCHEMA,
    )(_deploy_to_team)

    registry.register(
        'deploy_set_schedule',
        "Set or clear ('manual') the cron schedule of one source on a team's deployment (deploy_to_team "
        'first). source_id must be a source component of the deployed version; schedules fire only '
        'while the deployment is enabled.',
        _DEPLOY_SET_SCHEDULE_SCHEMA,
    )(_deploy_set_schedule)

    registry.register(
        'deploy_enable',
        "Enable a team's disabled deployment so its schedules fire again.",
        _DEPLOYMENT_KEY_SCHEMA,
    )(_deploy_enable)

    registry.register(
        'deploy_disable',
        "Disable a team's deployment -- the kill switch: schedules stop firing and manual runs are "
        'refused until deploy_enable.',
        _DEPLOYMENT_KEY_SCHEMA,
    )(_deploy_disable)

    registry.register(
        'deploy_remove',
        "Soft-remove a team's deployment: it leaves listings and stops running, but its versions and "
        'audit history are kept; deploy_to_team revives it.',
        _DEPLOYMENT_KEY_SCHEMA,
    )(_deploy_remove)
