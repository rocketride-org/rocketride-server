# Copyright 2026 Aparavi Software AG. MIT License.
"""`probe_component`: run one component's provider configuration check.

It sends the engine the single-component form ``{version, component}``, which
the node editor uses on save. The engine then runs that provider's own probe,
which can contact the configured model endpoint or database.
``validate_pipeline`` refuses this form and stays a static check.
"""

from typing import Any, Dict

from ..errors import _bad
from ..tooling import ToolHints, ToolRegistry
from ._common import engine_call

_PROBE_COMPONENT_DESCRIPTION = (
    "Test one component's settings against its provider. The engine runs that provider's own configuration "
    'check. Depending on the provider, the check can send a small request to the configured model endpoint or '
    'API, connect to the configured database, or run only local checks. A request to a model endpoint or API may '
    'be billed. Call it only when the user asks to test a component. ok is false when errors is non-empty. ok can '
    'be true when the provider rejected the settings, because a rejected key or a failed connection can come back '
    'in warnings. Report either one as a failed test. Some providers check settings only locally, so ok true with '
    'no warnings does not always mean a key works. Use validate_pipeline to check a whole pipeline without '
    'contacting a provider.'
)


async def _probe_component(client, tasks, args: Dict[str, Any]) -> dict:
    component = args.get('component')
    if not isinstance(component, dict):
        return _bad('component must be an object', 'pass one component from a pipeline, with its provider and config')
    version = args.get('version', 1)
    if type(version) is not int:
        return _bad('version must be a whole number', 'omit version to use 1')

    probed, err = await engine_call(client.validate({'version': version, 'component': component}), 'probe_component')
    if err:
        return err
    # Only the diagnostics: the engine's reply also echoes the component it was sent.
    result = probed or {}
    errors = result.get('errors') or []
    warnings = result.get('warnings') or []
    return {'ok': not errors, 'errors': errors, 'warnings': warnings}


def register(registry: ToolRegistry) -> None:
    """Register ``probe_component`` against ``registry``."""
    registry.register(
        'probe_component',
        _PROBE_COMPONENT_DESCRIPTION,
        {
            'type': 'object',
            'properties': {
                'component': {
                    'type': 'object',
                    'description': 'One component as it appears in a pipeline: id, provider and config',
                },
                'version': {'type': 'integer', 'description': 'Pipeline format version; omit for 1'},
            },
            'required': ['component'],
        },
        hints=ToolHints(
            read_only=False,
            destructive=True,
            open_world=True,
            reason="Runs the provider's own configuration probe inside the engine: LLM nodes send a small "
            'completion request to the configured endpoint, a charge that cannot be undone, and store nodes '
            'connect to the configured database with the supplied credentials. Destinations are '
            'caller-configured, so the tool is open-world. No run is started and nothing is saved.',
        ),
    )(_probe_component)
