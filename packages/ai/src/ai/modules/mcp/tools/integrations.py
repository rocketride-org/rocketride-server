# Copyright 2026 Aparavi Software AG. MIT License.
"""Integration discovery tool: `list_integrations`.

Surfaces the credential catalog (`..credentials`) as a caller-facing
readiness report -- distinct from `list_components`, which only lists
components already usable. Bare calls give a compact per-integration
status row; a `name` argument gives full field detail plus setup
instructions (`credentials.setup_block`) so the agent can relay concrete
next steps to the caller instead of a bare "not configured".
"""

from typing import Any, Dict

from .. import credentials as credentials_mod
from ..errors import _bad
from ..tooling import ToolRegistry
from ._common import engine_call


async def _list_integrations(client, tasks, args: Dict[str, Any]) -> dict:
    catalog = credentials_mod.load_catalog()
    name = args.get('name')

    if name is not None:
        spec = catalog.get(name)
        if spec is None:
            return _bad(f'Unknown integration: {name}', 'call list_integrations for valid names')

        env_keys = await credentials_mod.fetch_env_keys(client)
        state = credentials_mod.evaluate(spec, env_keys)
        result = {
            'ok': True,
            'name': spec.name,
            'title': spec.title,
            'fields': [
                {
                    'path': f.path,
                    'title': f.title,
                    'kind': f.kind,
                    'required': f.required,
                    'suggests': f.suggests,
                }
                for f in spec.fields
            ],
            'caller_variables': env_keys or [],
        }
        result.update(credentials_mod.describe_state(spec, state))
        return result

    services, err = await engine_call(client.get_services(), 'list_integrations')
    if err:
        return err
    definitions = (services or {}).get('services') or {}
    # Only catalog entries this engine actually has a matching node for --
    # an integration nobody here can use is noise, not a readiness signal.
    relevant = {n: catalog[n] for n in definitions if n in catalog}
    env_keys = await credentials_mod.fetch_env_keys(client) if relevant else None

    integrations = []
    for n in sorted(relevant):
        spec = relevant[n]
        state = credentials_mod.evaluate(spec, env_keys)
        integrations.append(
            {
                'name': spec.name,
                'title': spec.title,
                'status': state['status'],
                'missing_count': len(state['missing']),
            }
        )

    return {
        'ok': True,
        'integrations': integrations,
        'note': 'Call list_integrations with a name for full field detail and setup instructions.',
    }


def register(registry: ToolRegistry) -> None:
    """Register the integration-discovery tool against ``registry``."""
    registry.register(
        'list_integrations',
        'List credentialed integrations and their setup status. '
        'Entries include setup instructions you can relay to the user; unconfirmed entries '
        "list the caller's variable names so you can propose a binding and confirm with the "
        'user before using it. Pass a name for full field detail.',
        {
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Integration name for full field detail'},
            },
        },
    )(_list_integrations)
