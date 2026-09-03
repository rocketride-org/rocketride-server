# Copyright 2026 Aparavi Software AG. MIT License.
"""Capability tools: store + templates (`store_read`, `store_list`,
`store_stat`, `store_get_url`, `save_template`, `load_template`), and
deployments (`deploy_add`, `deploy_list`, `deploy_status`, `deploy_remove`,
`deploy_update`).
"""

from typing import Any, Dict

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

_DEPLOY_ADD_SCHEMA = {
    'type': 'object',
    'properties': {
        **_PIPELINE_SCHEMA_PROPS,
        'schedule': {'type': 'string', 'description': 'Optional cron schedule for the deployment'},
    },
    'required': ['pipeline'],
}

_DEPLOY_STATUS_SCHEMA = {
    'type': 'object',
    'properties': {
        'project_id': {'type': 'string', 'description': 'Project ID of the deployment'},
    },
    'required': ['project_id'],
}

_DEPLOY_REMOVE_SCHEMA = _DEPLOY_STATUS_SCHEMA

_DEPLOY_UPDATE_SCHEMA = {
    'type': 'object',
    'properties': {
        'project_id': {'type': 'string', 'description': 'Project ID of the deployment'},
        **_PIPELINE_SCHEMA_PROPS,
        'schedule': {'type': 'string', 'description': 'Replacement cron schedule (or "manual")'},
    },
    'required': ['project_id'],
    'anyOf': [{'required': ['pipeline']}, {'required': ['schedule']}],
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


async def _deploy_add(client, tasks, args: Dict[str, Any]) -> dict:
    pipeline = load_pipeline(args)  # raises ValueError -> normalized by the dispatch layer
    deployment, err = await _engine_call(client.deploy_add(pipeline, schedule=args.get('schedule')), 'deploy_add')
    if err:
        # Non-idempotent create: the engine may have registered the deployment
        # before the local budget elapsed — a blind retry would duplicate it.
        err['hint'] = 'the deployment may already exist; call deploy_list before retrying deploy_add'
        return err
    return {'ok': True, 'deployment': deployment}


async def _deploy_list(client, tasks, args: Dict[str, Any]) -> dict:
    deployments, err = await _engine_call(client.deploy_list(), 'deploy_list')
    if err:
        return err
    deployments = deployments or []
    return {'ok': True, 'deployments': deployments, 'count': len(deployments)}


async def _deploy_status(client, tasks, args: Dict[str, Any]) -> dict:
    project_id = args.get('project_id')
    if not project_id:
        return _bad('project_id is required', 'pass a deployment project_id (see deploy_list)')

    deployment, err = await _engine_call(client.deploy_status(project_id), 'deploy_status')
    if err:
        return err
    return {'ok': True, 'deployment': deployment}


async def _deploy_remove(client, tasks, args: Dict[str, Any]) -> dict:
    project_id = args.get('project_id')
    if not project_id:
        return _bad('project_id is required', 'pass a deployment project_id (see deploy_list)')

    _, err = await _engine_call(client.deploy_remove(project_id), 'deploy_remove')
    if err:
        return err
    return {'ok': True, 'removed': project_id}


async def _deploy_update(client, tasks, args: Dict[str, Any]) -> dict:
    project_id = args.get('project_id')
    if not project_id:
        return _bad('project_id is required', 'pass a deployment project_id (see deploy_list)')

    pipeline = None
    if args.get('pipeline'):
        pipeline = load_pipeline(args)  # raises ValueError -> normalized by the dispatch layer
    schedule = args.get('schedule')
    if pipeline is None and schedule is None:
        return _bad('nothing to update', 'pass a replacement pipeline and/or a schedule')

    _, err = await _engine_call(client.deploy_update(project_id, pipeline=pipeline, schedule=schedule), 'deploy_update')
    if err:
        return err
    updated = [k for k, v in (('pipeline', pipeline), ('schedule', schedule)) if v is not None]
    return {'ok': True, 'project_id': project_id, 'updated': updated}


def register(registry: ToolRegistry) -> None:
    """Register the store, template, and deployment tools against ``registry``.

    Store: `store_read`, `store_list`, `store_stat`, `store_get_url`.
    Templates: `save_template`, `load_template`.
    Deployments: `deploy_add`, `deploy_list`, `deploy_status`, `deploy_remove`,
    `deploy_update`.
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
        'Register an inline pipeline as a deployment, optionally on a cron schedule.',
        _DEPLOY_ADD_SCHEMA,
    )(_deploy_add)

    registry.register(
        'deploy_list',
        "List the user's deployments with their status and schedule.",
        {'type': 'object', 'properties': {}},
    )(_deploy_list)

    registry.register(
        'deploy_status',
        'Get detailed status of one deployment by project_id.',
        _DEPLOY_STATUS_SCHEMA,
    )(_deploy_status)

    registry.register(
        'deploy_remove',
        'Undeploy and remove a deployment by project_id.',
        _DEPLOY_REMOVE_SCHEMA,
    )(_deploy_remove)

    registry.register(
        'deploy_update',
        "Update a deployment's pipeline and/or schedule by project_id.",
        _DEPLOY_UPDATE_SCHEMA,
    )(_deploy_update)
